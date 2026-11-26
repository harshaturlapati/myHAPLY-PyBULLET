// haply_lab_engine.cpp - the real-time half of the Haply lab console.
//
// Owns the Inverse3 and runs the haptic loop at 1 kHz:  read x, v  ->  F = scenario equation  ->  send F.
// The web server (lab/haply_lab.py) is never in this loop. It talks to the engine with short UDP text messages
// on 127.0.0.1, and the engine applies them between two 1 ms cycles:
//
//   engine -> server  (127.0.0.1:47001, 100 Hz)  one JSON line with the state and the active parameters
//   server -> engine  (127.0.0.1:47002)          commands, one per datagram:
//       hb                                       heartbeat from the page in control (forces need it)
//       forces 1 | forces 0                      switch forces on / off
//       set kind free|impedance|wall|custom
//       set xd X Y Z | set rpy R P Y | set k KX KY KZ | set b BX BY BZ | set fmax F   (SI units, radians)
//       expr fx|fy|fz <equation>                 custom equations (see libs/myEXPR.h)
//       rec start <label> | rec stop             record at the full loop rate to <data>/<date>__<label>.csv
//       sim X Y Z                                simulator only: where the virtual hand should go
//       device release | device acquire         free /dev/haply for other programs, or take it back
//       alive                                    the server is still there (with --parent-timeout)
//       quit
//
// Who may send commands? Any program on this computer can send a datagram to 127.0.0.1:47002, including a
// student's shell in the lab's Terminal tab. So the server makes a random token when it starts and gives it
// to the engine in the environment variable HAPLY_LAB_TOKEN (never on the command line: every user can read
// the command lines of all processes). Every datagram, in both directions, is "<token> <text>"; anything
// else is dropped and counted ("auth_drops" in the state). Without HAPLY_LAB_TOKEN the engine runs in open
// developer mode: bare commands, bare JSON, a warning at start-up, and "auth":false in the state.
// Datagrams longer than 1024 bytes are dropped, commands with bytes outside printable ASCII are refused, and
// at most 64 datagrams are handled per cycle, so even a flood of messages cannot stop the haptic loop.
//
// Safety layers, all in this file (the equations in myHAPLY_SCENARIOS.h stay pure maths):
//   * forces start OFF, need a connected (not released), calibrated device and a heartbeat less than 1 s old
//   * every cycle:  F = F_eq  ->  not a finite number? zero  ->  |F| capped at fmax  ->  times the fade-in
//     ramp, which grows from 0 to 1 in 1 s (so the full force always takes 1 s to arrive)
//   * |F| <= fmax <= 4 N;  k <= 1000 N/m, b <= 15 N s/m per axis; the target point moves at most 0.1 m/s,
//     k, b and the orientation change gradually, and fmax may drop at once but rises at most 2 N/s,
//     so dragging a slider never produces a jump
//   * forces switch off if |v| > 1.5 m/s (an unstable spring usually shows up as speed first)
//   * after 3 failed device exchanges in a row the force is held at zero (x and v are old), then fades in again
//   * forces switch off and a zero-force frame is sent when the device is lost or released, on "quit", on
//     Ctrl+C, SIGTERM or SIGHUP (Windows: Ctrl+C, Ctrl+Break, closing the console), and if an error escapes
//     the loop. (Only an uncatchable kill - SIGKILL, TerminateProcess - skips this, so ask with "quit" first.)
//   * the loop never waits for the disk: recordings go into memory reserved at start-up and one background
//     thread writes the files
//
// Usage:  haply_lab_engine [--sim] [--port COM5|/dev/haply] [--data DIR] [--rate 1000]
//                          [--state-port 47001] [--cmd-port 47002] [--parent-timeout S]
//         environment: HAPLY_LAB_TOKEN=<at least 16 printable characters, no spaces>

#include <myINCLUDES.h>
#include <myHAPLY_v1.h>
#include <myHAPLY_SCENARIOS.h>
#include <myUDP.h>

#include <algorithm>
#include <condition_variable>
#include <mutex>

#if defined(__linux__)
  #include <pthread.h>
  #include <sched.h>
  #include <sys/mman.h>
#endif
#if !defined(_WIN32)
  #include <signal.h>
#endif

using haptics::Vec3;

namespace {

constexpr double K_MAX = 1000.0, B_MAX = 15.0, FMAX_HARD = 4.0, V_GUARD = 1.5;
constexpr double XD_RATE = 0.10;        // m/s       how fast the target point may move
constexpr double K_RATE = 2000.0;       // N/m/s     how fast stiffness may change
constexpr double B_RATE = 30.0;         // N s/m/s
constexpr double RPY_RATE = 1.0;        // rad/s
constexpr double FMAX_RATE = 2.0;       // N/s       how fast the force limit may rise (it may drop at once)
constexpr double K_JUMP = 100.0;        // N/m       a bigger change of k in one command fades the force in again
constexpr double B_JUMP = 3.0;          // N s/m     the same for b
constexpr double RAMP_TIME = 1.0;       // s         forces fade in over this time
constexpr double HB_TIMEOUT = 1.0;      // s
constexpr double REC_MAX_S = 600.0;     // s         longest recording kept in memory
constexpr size_t REC_MAX_ROWS = 1500000;          // ... and never more rows than this (108 MB), whatever the rate
constexpr long long REC_MIN_FREE_MB = 200;        // free space needed in the data folder to start a recording
constexpr int STALE_ERRORS = 3;         // failed exchanges in a row before the force is held at zero
constexpr int LOST_ERRORS = 50;         // failed exchanges in a row before the device counts as lost
constexpr int MAX_DATAGRAMS = 64;       // datagrams handled per loop iteration
constexpr size_t MAX_DATAGRAM_BYTES = 1024;
constexpr double PI = 3.14159265358979323846;

struct Row {
    int64_t t_us, unix_ns;
    float x[3], v[3], f[3], e[3];
    float ramp, loop_us;
};

std::string fmt3(const Vec3& a, int prec = 6) {
    double v[3];
    for (int i = 0; i < 3; i++) v[i] = std::isfinite(a[i]) ? a[i] : 0.0;   // JSON has no NaN or infinity
    char b[128];
    std::snprintf(b, sizeof(b), "[%.*f,%.*f,%.*f]", prec, v[0], prec, v[1], prec, v[2]);
    return b;
}

// Every string in the state goes through here, so the JSON is always valid, pure ASCII. (One stray byte
// >= 0x80 would make the server's decoder throw away every state packet that contains it.)
std::string json_escape(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (char ch : s) {
        const unsigned char c = (unsigned char)ch;
        if (c == '"' || c == '\\') { o += '\\'; o += ch; }
        else if (c < 0x20) o += ' ';
        else if (c > 0x7E) o += '?';
        else o += ch;
    }
    return o;
}

bool printable_ascii(const std::string& s) {
    for (char ch : s)
        if ((unsigned char)ch < 0x20 || (unsigned char)ch > 0x7E) return false;
    return true;
}

// An angle in (-pi, pi]. 900 degrees is the same orientation as 180 degrees, and wrapping it first means the
// rate limiter never sweeps the frame (and the force direction) round and round for seconds.
double wrap_pi(double a) {
    a = std::remainder(a, 2.0 * PI);          // now in [-pi, pi]
    return a <= -PI ? a + 2.0 * PI : a;
}

Vec3 step_towards(const Vec3& cur, const Vec3& tgt, double max_step) {
    Vec3 d = tgt - cur;
    const double n = d.norm();
    return n <= max_step ? tgt : cur + d * (max_step / n);
}
Vec3 step_each(const Vec3& cur, const Vec3& tgt, double max_step) {
    Vec3 o;
    for (int i = 0; i < 3; i++) o[i] = cur[i] + std::clamp(tgt[i] - cur[i], -max_step, max_step);
    return o;
}

void lower_this_thread_priority() {
#if defined(__linux__)
    sched_param p{};
    pthread_setschedparam(pthread_self(), SCHED_OTHER, &p);
    cpu_set_t set;
    CPU_ZERO(&set);
    const long n = sysconf(_SC_NPROCESSORS_ONLN);
    for (long i = 0; i + 1 < n; i++) CPU_SET((int)i, &set);   // every core except the engine's
    if (n > 1) pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
#elif defined(_WIN32)
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
#endif
}

std::string realtime_setup() {
#if defined(__linux__)
    std::string out;
    const long n = sysconf(_SC_NPROCESSORS_ONLN);
    if (n > 1) {
        cpu_set_t set;
        CPU_ZERO(&set);
        CPU_SET((int)(n - 1), &set);
        if (sched_setaffinity(0, sizeof(set), &set) == 0) out += "pinned to CPU " + std::to_string(n - 1) + "; ";
    }
    sched_param p{};
    p.sched_priority = 40;
    out += sched_setscheduler(0, SCHED_FIFO, &p) == 0 ? "real-time priority (SCHED_FIFO 40); "
                                                      : "normal priority (no permission for real-time); ";
    if (mlockall(MCL_CURRENT | MCL_FUTURE) == 0) out += "memory locked";
    return out;
#elif defined(_WIN32)
    SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
    return "high priority";
#else
    return "normal priority";
#endif
}

// ------------------------------------------------------------------------------------- stopping from outside
// Ctrl+C, "systemctl stop" (SIGTERM) or a closed terminal (SIGHUP) must not kill the engine on the spot: the
// device would keep the last force it was sent. The handler only sets this flag; the loop sees it within one
// cycle, sends zero force, closes the port and saves an active recording. 0 = keep running, otherwise which
// signal (on Windows: console event + 1). A lock-free std::atomic may be set from a signal handler.
std::atomic<int> g_stop_signal{0};
std::atomic<bool> g_cleanup_done{false};

#if defined(_WIN32)
BOOL WINAPI on_console_event(DWORD ev) {
    g_stop_signal = (int)ev + 1;
    // After a close, log-off or shutdown event Windows ends the process as soon as this function returns,
    // so wait here (at most 5 s) until the loop has sent zero force and saved the recording.
    if (ev == CTRL_CLOSE_EVENT || ev == CTRL_LOGOFF_EVENT || ev == CTRL_SHUTDOWN_EVENT)
        for (int i = 0; i < 500 && !g_cleanup_done; i++) Sleep(10);
    return TRUE;
}
#else
void on_signal(int sig) { g_stop_signal = sig; }
#endif

void install_stop_handlers() {
#if defined(_WIN32)
    // Started by the lab server in its own process group, the engine ignores Ctrl+C (on purpose: the server
    // stops it in order, forces first). Ctrl+Break, which the server can send to the group, and closing the
    // console still arrive here. Started by hand in a console, Ctrl+C arrives here too.
    SetConsoleCtrlHandler(on_console_event, TRUE);
#else
    struct sigaction sa{};
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = SA_RESTART;
    sigaction(SIGINT, &sa, nullptr);
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGHUP, &sa, nullptr);
    // If the server dies, our stdout pipe closes; printing would then raise SIGPIPE, whose default is to kill
    // the process before it can send the zero-force frame. Ignore it (the write just fails).
    signal(SIGPIPE, SIG_IGN);
#endif
}

std::string stop_name(int s) {
#if defined(_WIN32)
    switch (s - 1) {
        case CTRL_C_EVENT: return "Ctrl+C";
        case CTRL_BREAK_EVENT: return "Ctrl+Break";
        case CTRL_CLOSE_EVENT: return "console closed";
        default: return "Windows is logging off or shutting down";
    }
#else
    switch (s) {
        case SIGINT: return "SIGINT (Ctrl+C)";
        case SIGTERM: return "SIGTERM";
        case SIGHUP: return "SIGHUP";
    }
    return "signal " + std::to_string(s);
#endif
}

}  // namespace

class LabEngine {
public:
    // options
    bool sim = false;
    std::string port, data_dir = "lab_data";
    double rate_hz = 1000.0;
    int state_port = 47001, cmd_port = 47002;
    double parent_timeout = 0;   // > 0: quit when the server has said nothing for this long (it sends "alive" every second)
    std::string token;           // HAPLY_LAB_TOKEN; empty = open developer mode

    ~LabEngine() { stop_writer(); }

    int run() {
        my::HighResTimer high_res_timer;
        (void)high_res_timer;
        if (!udp_.open(cmd_port, "127.0.0.1", state_port)) {
            fprintf(stderr, "Cannot open UDP port %d (is another engine running?)\n", cmd_port);
            return 1;
        }
        if (token.empty())
            printf("haply_lab_engine: WARNING - HAPLY_LAB_TOKEN is not set: ANY program on this computer may send "
                   "commands (open developer mode). The lab server always sets it.\n");
        std::error_code ec;
        std::filesystem::create_directories(data_dir, ec);
        reserve_recording_memory();
        writer_ = std::thread([this] { writer_main(); });   // started before the loop, so the loop never starts threads
        rt_info_ = realtime_setup();
        printf("haply_lab_engine: %s mode, %.0f Hz, %s, %s\n", sim ? "SIMULATOR" : "device", rate_hz, rt_info_.c_str(),
               token.empty() ? "no command token" : "commands need the token");
        fflush(stdout);
        set_msg(sim ? "simulator running (no device)" : "engine started");

        const auto period = std::chrono::duration_cast<my::Clock::duration>(std::chrono::duration<double>(1.0 / rate_hz));
        const double dt = 1.0 / rate_hz;
        t0_ = my::Clock::now();
        auto t_next = t0_;
        auto t_pub = t0_;
        auto t_retry = t0_;
        auto t_rate = t0_;
        long long rate_count = 0;
        int exit_code = 0;
        std::string stop_reason = "quit command";
        std::string m;                        // reused for every datagram, so receiving does not allocate
        m.reserve(4096);

        while (!quit_ && g_stop_signal == 0) {
            try {
                // 1. commands from the server (never blocks; at most MAX_DATAGRAMS per cycle)
                receive_commands(m);

                const auto now = my::Clock::now();
                const double t = std::chrono::duration<double>(now - t0_).count();
                if (parent_timeout > 0 && t - last_cmd_ > parent_timeout) {
                    printf("haply_lab_engine: no message from the server for %.0f s - stopping\n", parent_timeout);
                    stop_reason = "the server stopped talking";
                    break;
                }

                // 2. keep the device connected (device mode)
                if (!sim && !connected_ && !released_ && now >= t_retry) {
                    t_retry = now + std::chrono::seconds(2);
                    try_connect();
                }

                // 3. one haptic cycle
                if (sim || connected_) {
                    cycle(t, dt);
                    rate_count++;
                }

                // 4. publish the state at ~100 Hz (5 Hz while waiting for a device)
                const auto pub_period = (sim || connected_) ? std::chrono::milliseconds(10) : std::chrono::milliseconds(200);
                if (now >= t_pub) {
                    t_pub = now + pub_period;
                    if (now - t_rate >= std::chrono::seconds(1)) {
                        loop_hz_ = (double)rate_count / std::chrono::duration<double>(now - t_rate).count();
                        rate_count = 0;
                        t_rate = now;
                    }
                    publish(t);
                }

                // 5. wait for the next tick
                t_next += period;
                if (t_next < my::Clock::now() - 5 * period) t_next = my::Clock::now();   // fell far behind: resync
                if (sim || connected_) my::sleep_until(t_next);
                else std::this_thread::sleep_for(std::chrono::milliseconds(5));
            } catch (const std::exception& ex) {
                force_off_now();                  // zero force first, explain afterwards
                fprintf(stderr, "haply_lab_engine: error in the loop: %s\n", ex.what());
                stop_reason = std::string("internal error: ") + ex.what();
                exit_code = 3;
                break;
            } catch (...) {
                force_off_now();
                fprintf(stderr, "haply_lab_engine: unknown error in the loop\n");
                stop_reason = "internal error";
                exit_code = 3;
                break;
            }
        }
        if (g_stop_signal != 0) stop_reason = stop_name(g_stop_signal);
        shutdown(stop_reason);
        return exit_code;
    }

private:
    my::UdpSocket udp_;
    myHAPLY haply_{"Inverse3"};
    bool connected_ = false, released_ = false, quit_ = false;
    std::string rt_info_, connect_msg_;
    my::Clock::time_point t0_;
    long long auth_drops_ = 0;   // datagrams dropped before they reached handle(): wrong or missing token, too long

    // scenario: what the student asked for (target) and what is applied now (rate-limited)
    haptics::Scenario scn_;
    Vec3 xd_tgt_ = Vec3::Zero(), rpy_tgt_ = Vec3::Zero(), k_tgt_ = Vec3::Zero(), b_tgt_ = Vec3::Zero();
    double fmax_tgt_ = 2.0;      // force limit asked for (N)
    double fmax_ = 2.0;          // force limit in use (N): follows fmax_tgt_, rising at most FMAX_RATE

    // state
    Vec3 x_ = Vec3::Zero(), v_ = Vec3::Zero(), F_ = Vec3::Zero(), e_ = Vec3::Zero();
    bool calibrated_ = false, forces_ = false;
    double ramp_ = 0.0, loop_hz_ = 0.0, last_hb_ = -1e9, last_cmd_ = 0.0;
    float exchange_us_ = 0;
    long long errors_ = 0;

    // messages for the page
    std::string msg_;
    int msg_id_ = 0;

    // simulator: a virtual hand holds the cursor through a spring; the student's forces push the cursor away
    Vec3 hand_ = Vec3::Zero(), sim_target_ = Vec3::Zero();
    double sim_target_until_ = -1;

    // recording: rows go into rec_buf_, which is allocated (and every page touched) once at start-up; on
    // "rec stop" the rows are handed to the writer thread, and no new recording starts until it is done
    struct WriteJob {
        size_t rows = 0;
        std::string header, label, stamp;
    };
    bool recording_ = false;
    std::string rec_label_, rec_header_;
    std::vector<Row> rec_buf_;
    size_t rec_n_ = 0;                       // rows recorded so far
    double rec_t0_ = 0;
    std::thread writer_;
    std::mutex job_mutex_;                   // guards job_, job_pending_, writer_quit_
    std::condition_variable job_cv_;
    WriteJob job_;
    bool job_pending_ = false, writer_quit_ = false;
    std::atomic<bool> writer_busy_{false};   // true from "rec stop" until the file is closed
    std::atomic<long long> space_mb_{-1};    // free MB in data_dir (-1 = unknown), measured by the writer thread
    std::mutex file_mutex_;                  // guards last_file_ and writer_msg_
    std::string last_file_, writer_msg_;

    double now_t() const { return std::chrono::duration<double>(my::Clock::now() - t0_).count(); }

    void set_msg(const std::string& s) {
        msg_ = s.size() > 300 ? s.substr(0, 297) + "..." : s;
        msg_id_++;
    }

    // ---------------------------------------------------------------- receiving commands
    void receive_commands(std::string& m) {
        for (int n = 0; n < MAX_DATAGRAMS; n++) {
            bool too_long = false;
            if (!udp_.recv(m, MAX_DATAGRAM_BYTES, &too_long)) return;     // nothing more waiting
            if (too_long || !strip_token(m)) { auth_drops_++; continue; }
            if (!printable_ascii(m)) { set_msg("refused a command with characters outside printable ASCII"); continue; }
            if (!m.empty()) handle(m);
        }
    }

    // "<token> <command>" -> "<command>". False if the first word is not exactly the token.
    // Every byte is compared even after a mismatch, so the time taken tells an attacker nothing.
    bool strip_token(std::string& m) const {
        if (token.empty()) return true;                       // open developer mode
        const size_t sp = m.find(' ');
        const size_t n = sp == std::string::npos ? m.size() : sp;
        if (n != token.size()) return false;
        unsigned char diff = 0;
        for (size_t i = 0; i < n; i++) diff |= (unsigned char)(m[i] ^ token[i]);
        if (diff != 0) return false;
        m.erase(0, sp == std::string::npos ? n : n + 1);
        return true;
    }

    // ---------------------------------------------------------------- the device comes and goes
    void try_connect() {
        haply_.port = port;
        haply_.timeout_ms = 20;
        haply_.F_max = (float)FMAX_HARD;   // the engine's own clamp (fmax <= 4 N) is the one that counts
        if (haply_.connect()) {
            connected_ = true;
            // a new connection starts like a new program: forces off, no old position, calibration unknown
            forces_ = false;
            ramp_ = 0.0;
            calibrated_ = false;
            x_.setZero();
            v_.setZero();
            connect_msg_.clear();
            set_msg("Inverse3 connected on " + haply_.port);
        } else if (haply_.last_error != connect_msg_) {
            connect_msg_ = haply_.last_error;                 // say it once, not every 2 s
            set_msg("waiting for the Inverse3: " + connect_msg_);
        }
    }

    // The device stops being ours (lost or released): forces off, a zero-force frame while the port still works,
    // and forget the old position and calibration, so nothing stale is used when it comes back.
    void drop_device(const std::string& why) {
        force_off_now();
        calibrated_ = false;
        x_.setZero();
        v_.setZero();
        set_msg(why);
    }

    // Forces off at once and, if the port is open, zero force sent (up to 3 tries) before it is closed.
    void force_off_now() {
        forces_ = false;
        ramp_ = 0.0;
        F_.setZero();
        if (haply_.is_connected()) haply_.quick_stop();
        connected_ = false;
    }

    // ---------------------------------------------------------------- one 1 ms cycle
    void cycle(double t, double dt) {
        // --- parameters move smoothly towards what was asked
        scn_.x_d = step_towards(scn_.x_d, xd_tgt_, XD_RATE * dt);
        scn_.k = step_each(scn_.k, k_tgt_, K_RATE * dt);
        scn_.b = step_each(scn_.b, b_tgt_, B_RATE * dt);
        scn_.rpy = step_each(scn_.rpy, rpy_tgt_, RPY_RATE * dt);
        fmax_ = fmax_tgt_ < fmax_ ? fmax_tgt_ : std::min(fmax_tgt_, fmax_ + FMAX_RATE * dt);   // down at once, up slowly

        // --- force from the scenario equation, using the latest position and velocity
        Vec3 F = Vec3::Zero();
        haptics::Detail det;
        const Vec3 F_eq = haptics::force(scn_, x_, v_, t, &det);
        e_ = det.e;
        if (forces_) {
            if (!calibrated_) { forces_ = false; set_msg("forces off: the device is not calibrated"); }
            else if (t - last_hb_ > HB_TIMEOUT) { forces_ = false; set_msg("forces off: the page stopped answering (watchdog)"); }
            else if (!v_.allFinite()) { forces_ = false; set_msg("forces off: the device reported an invalid velocity"); }
            else if (v_.norm() > V_GUARD) {
                forces_ = false;
                char b[120];
                std::snprintf(b, sizeof(b), "forces off: speed guard, |v| = %.2f m/s (limit %.1f). Lower k or raise b.", v_.norm(), V_GUARD);
                set_msg(b);
            }
        }
        if (forces_) {
            ramp_ = std::min(1.0, ramp_ + dt / RAMP_TIME);
            F = F_eq;
            if (!F.allFinite()) F.setZero();
            const double n = F.norm();
            if (n > fmax_) F *= fmax_ / n;    // first cap the size (the direction stays the same) ...
            F *= ramp_;                       // ... then fade in: full force only after RAMP_TIME, however large F_eq
            if (!sim && haply_.consecutive_errors >= STALE_ERRORS) {
                F.setZero();                  // x and v are several cycles old: push nothing until fresh data,
                ramp_ = 0.0;                  // then fade in again
            }
        } else {
            ramp_ = 0.0;
        }
        F_ = F;

        // --- exchange with the device (or the simulator)
        if (sim) {
            sim_step(t, dt, F);
            exchange_us_ = 0;
        } else {
            for (int i = 0; i < 3; i++) haply_.F_cmd[i] = (float)F[i];
            const bool ok = haply_.render_F_cmd();
            exchange_us_ = haply_.last_exchange_us;
            if (ok) {
                calibrated_ = haply_.calibrated;
                for (int i = 0; i < 3; i++) { x_[i] = haply_.X[i]; v_[i] = haply_.V[i]; }
                if (!calibrated_) { x_.setZero(); v_.setZero(); }
            } else {
                errors_++;
                if (haply_.consecutive_errors > LOST_ERRORS)
                    drop_device("lost the Inverse3 (" + haply_.last_error + "); forces off, retrying");
            }
        }

        // --- record at the full rate
        if (recording_) {
            if (rec_n_ < rec_buf_.size()) {
                Row& r = rec_buf_[rec_n_++];
                r.t_us = my::tick_us();
                r.unix_ns = my::unix_ns();
                for (int i = 0; i < 3; i++) { r.x[i] = (float)x_[i]; r.v[i] = (float)v_[i]; r.f[i] = (float)F[i]; r.e[i] = (float)e_[i]; }
                r.ramp = (float)ramp_;
                r.loop_us = exchange_us_;
            } else {
                stop_recording("recording stopped: maximum length reached");
            }
        }
    }

    void sim_step(double t, double dt, const Vec3& F) {
        // the hand follows a slow figure-eight, or the point dragged on the page
        if (t < sim_target_until_) hand_ = step_towards(hand_, sim_target_, 0.5 * dt);
        else {
            const double w = 2 * PI * 0.12;
            const Vec3 fig(0.04 * std::sin(w * t), 0.03 * std::sin(2 * w * t), 0.02 * std::cos(w * t));
            hand_ = step_towards(hand_, fig, 0.1 * dt);
        }
        // cursor of mass m held by the hand (spring kh, damper bh), pushed by the haptic force F
        const double m = 0.15, kh = 150.0, bh = 6.0;
        const Vec3 a = (kh * (hand_ - x_) - bh * v_ + F) / m;
        v_ += a * dt;               // semi-implicit Euler: velocity first, then position
        x_ += v_ * dt;
        calibrated_ = true;
    }

    // ---------------------------------------------------------------- commands
    void handle(const std::string& line) {
        std::istringstream in(line);
        std::string cmd;
        in >> cmd;
        const double t = now_t();
        last_cmd_ = t;
        if (cmd == "alive") return;
        if (cmd == "hb") { last_hb_ = t; return; }
        if (cmd == "forces") {
            int on = 0;
            in >> on;
            if (on) {
                if (!sim && released_) { set_msg("cannot switch forces on: the device is released (take it back first)"); return; }
                if (!sim && !connected_) { set_msg("cannot switch forces on: no device connected"); return; }
                if (!calibrated_) { set_msg("cannot switch forces on: the device is not calibrated"); return; }
                if (t - last_hb_ > HB_TIMEOUT) { set_msg("cannot switch forces on: no heartbeat from the page"); return; }
                if (!forces_) { ramp_ = 0; set_msg("forces ON (fading in over 1 s)"); }
                forces_ = true;
            } else {
                if (forces_) set_msg("forces off");
                forces_ = false;
            }
            return;
        }
        if (cmd == "set") {
            std::string what;
            in >> what;
            if (what == "kind") {
                std::string k;
                in >> k;
                haptics::Kind kind;
                if (!haptics::kind_from_name(k, kind)) { set_msg("unknown scenario '" + k.substr(0, 40) + "'"); return; }
                if (kind != scn_.kind) { scn_.kind = kind; ramp_ = 0; set_msg(std::string("scenario: ") + k); }
                return;
            }
            if (what == "fmax") {
                double f = 0;
                if (!(in >> f) || !std::isfinite(f)) { set_msg("'set fmax' needs a number"); return; }
                fmax_tgt_ = std::clamp(f, 0.0, FMAX_HARD);
                if (fmax_tgt_ < fmax_) fmax_ = fmax_tgt_;   // a lower limit applies at once (cycle() raises it slowly)
                return;
            }
            double a = 0, b = 0, c = 0;
            if (!(in >> a >> b >> c) || !std::isfinite(a) || !std::isfinite(b) || !std::isfinite(c)) {
                set_msg("'set " + what.substr(0, 40) + "' needs three numbers");
                return;
            }
            const Vec3 v3(a, b, c);
            if (what == "xd") xd_tgt_ = v3.cwiseMax(Vec3::Constant(-0.3)).cwiseMin(Vec3::Constant(0.3));
            else if (what == "rpy") rpy_tgt_ = Vec3(wrap_pi(a), wrap_pi(b), wrap_pi(c));
            else if (what == "k" || what == "b") {
                Vec3& tgt = what == "k" ? k_tgt_ : b_tgt_;
                const double lim = what == "k" ? K_MAX : B_MAX;
                const Vec3 next = v3.cwiseMax(Vec3::Zero()).cwiseMin(Vec3::Constant(lim));
                // Dragging a slider changes k or b in small steps (smooth). One big jump, e.g. switching from
                // "Damping field" (k = 0) to "Spring" (k = 300) far from the target, would step the force within a
                // few ms even with the rate limit, so a big jump fades the force in again instead.
                const double big = what == "k" ? K_JUMP : B_JUMP;
                if (forces_ && (next - tgt).cwiseAbs().maxCoeff() > big) { ramp_ = 0; set_msg("big change in " + what + ": forces fade in again"); }
                tgt = next;
            }
            else set_msg("unknown parameter '" + what.substr(0, 40) + "'");
            return;
        }
        if (cmd == "expr") {
            std::string axis, text;
            in >> axis;
            std::getline(in, text);
            const size_t s = text.find_first_not_of(' ');
            text = s == std::string::npos ? "" : text.substr(s);
            my::Expr* e = axis == "fx" ? &scn_.fx : axis == "fy" ? &scn_.fy : axis == "fz" ? &scn_.fz : nullptr;
            if (!e) { set_msg("expr needs fx, fy or fz"); return; }
            const bool custom = scn_.kind == haptics::Kind::Custom;
            if (text.empty() || text == "0") {
                if (!e->empty()) { e->clear(); if (custom) ramp_ = 0; }   // fade in again only if something changed
                return;
            }
            if (text == e->source()) return;   // the same equation again (the page resends all three): no change
            std::string err;
            if (!e->compile(text, err)) {
                // Never keep running an older equation than the one the page shows: this axis becomes 0,
                // and if it was driving the device, forces switch off.
                const bool was_on = custom && forces_;
                e->clear();
                if (was_on) { forces_ = false; ramp_ = 0; }
                set_msg(std::string(was_on ? "forces off: " : "") + axis + " error: " + err);
                return;
            }
            if (custom) ramp_ = 0;
            set_msg(axis + " = " + text);
            return;
        }
        if (cmd == "rec") {
            std::string what, label;
            in >> what;
            std::getline(in, label);
            if (what == "start") start_recording(label);
            else if (what == "stop") stop_recording("recording stopped");
            return;
        }
        if (cmd == "sim") {
            double a = 0, b = 0, c = 0;
            if (in >> a >> b >> c && std::isfinite(a) && std::isfinite(b) && std::isfinite(c)) {
                sim_target_ = Vec3(a, b, c).cwiseMax(Vec3::Constant(-0.3)).cwiseMin(Vec3::Constant(0.3));
                sim_target_until_ = t + 1.5;
            }
            return;
        }
        if (cmd == "device") {
            std::string what;
            in >> what;
            if (what == "release" && !sim) {
                drop_device("device released: other programs can use it now");
                released_ = true;
            } else if (what == "acquire") {
                released_ = false;
                connect_msg_.clear();
                set_msg("taking the device back...");
            }
            return;
        }
        if (cmd == "quit") { forces_ = false; quit_ = true; return; }
        set_msg("unknown command '" + cmd.substr(0, 40) + "'");
    }

    // ---------------------------------------------------------------- recording
    void reserve_recording_memory() {
        const size_t rows = (size_t)std::min(REC_MAX_S * rate_hz, (double)REC_MAX_ROWS);
        try {
            rec_buf_.resize(rows);   // resize (not reserve) writes every row once, so the memory exists before the loop
        } catch (const std::bad_alloc&) {
            rec_buf_ = std::vector<Row>();
            fprintf(stderr, "haply_lab_engine: not enough memory for recordings (%zu rows); recording is disabled\n", rows);
        }
    }

    void start_recording(const std::string& label) {
        if (recording_) { set_msg("already recording '" + rec_label_ + "': stop it first"); return; }
        if (writer_busy_) { set_msg("cannot start recording yet: still saving the previous one, try again in a few seconds"); return; }
        if (rec_buf_.empty()) { set_msg("cannot start recording: no memory for recordings (see the engine log)"); return; }
        const long long mb = space_mb_;
        if (mb >= 0 && mb < REC_MIN_FREE_MB) {
            set_msg("cannot start recording: only " + std::to_string(mb) + " MB free in the data folder (need " +
                    std::to_string(REC_MIN_FREE_MB) + " MB)");
            return;
        }
        std::string clean;
        for (char c : label) if (std::isalnum((unsigned char)c) || c == '-' || c == '_') clean += c; else if (c == ' ' && !clean.empty()) clean += '_';
        if (clean.size() > 60) clean.resize(60);
        rec_label_ = clean.empty() ? "experiment" : clean;
        rec_n_ = 0;
        rec_header_ = scenario_comment();
        rec_t0_ = now_t();
        recording_ = true;
        set_msg("recording '" + rec_label_ + "'");
    }

    std::string scenario_comment() const {
        std::ostringstream o;
        o << "# myHAPLY lab recording, " << (sim ? "SIMULATOR" : "Inverse3") << ", " << rate_hz << " Hz\n";
        o << "# scenario: kind=" << haptics::kind_name(scn_.kind) << " xd=" << fmt3(xd_tgt_) << " rpy=" << fmt3(rpy_tgt_)
          << " k=" << fmt3(k_tgt_, 1) << " b=" << fmt3(b_tgt_, 2) << " fmax=" << fmax_tgt_ << "\n";
        if (scn_.kind == haptics::Kind::Custom)
            o << "# expr: fx=" << scn_.fx.source() << " ; fy=" << scn_.fy.source() << " ; fz=" << scn_.fz.source() << "\n";
        o << "# columns: X,Y,Z m; VX,VY,VZ m/s; f1..f3 force sent (N); e1..e3 error x_d-x in the target frame (m); "
             "ramp 0..1; loop_us device round trip\n";
        return o.str();
    }

    // Hands the recorded rows to the writer thread. Never waits: the loop keeps running while the file is written.
    void stop_recording(const std::string& why) {
        if (!recording_) return;
        recording_ = false;
        {
            std::lock_guard<std::mutex> lock(job_mutex_);
            job_.rows = rec_n_;
            job_.header = std::move(rec_header_);
            job_.label = rec_label_;
            job_pending_ = true;
            writer_busy_ = true;
        }
        job_cv_.notify_one();
        char b[200];
        std::snprintf(b, sizeof(b), "%s: saving %.1f s of data...", why.c_str(), (double)rec_n_ / rate_hz);
        set_msg(b);
    }

    // The writer thread: low priority, on the other cores. Writes one recording at a time, and every 2 s
    // measures the free disk space (so the 1 kHz loop never has to ask the file system).
    void writer_main() {
        lower_this_thread_priority();
        for (;;) {
            update_free_space();
            WriteJob job;
            {
                std::unique_lock<std::mutex> lock(job_mutex_);
                job_cv_.wait_for(lock, std::chrono::seconds(2), [this] { return job_pending_ || writer_quit_; });
                if (job_pending_) { job = std::move(job_); job_pending_ = false; }
                else if (writer_quit_) return;
                else continue;
            }
            job.stamp = my::timestamp_string();   // date and time of "rec stop" (read here: it may touch the time-zone file)
            write_recording(job);
            update_free_space();
            writer_busy_ = false;
        }
    }

    // keep_publishing: while a recording is still being written, send the server a state every 200 ms so it
    // knows the engine is alive (forces are already off) and does not kill it before the file is on disk.
    void stop_writer(bool keep_publishing = false) {
        if (!writer_.joinable()) return;
        {
            std::lock_guard<std::mutex> lock(job_mutex_);
            writer_quit_ = true;             // a pending recording is still written first
        }
        job_cv_.notify_one();
        auto last = my::Clock::now();
        while (keep_publishing && writer_busy_) {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
            if (my::Clock::now() - last >= std::chrono::milliseconds(200)) { publish(now_t()); last = my::Clock::now(); }
        }
        writer_.join();
    }

    void update_free_space() {
        std::error_code ec;
        const std::filesystem::space_info s = std::filesystem::space(data_dir, ec);
        space_mb_ = ec ? -1 : (long long)(s.available / (1024 * 1024));
    }

    // Writes <stamp>__<label>.csv. The file is written as .csv.part and renamed at the end, so a half-written
    // file never shows up in the recordings list; if anything fails (a full disk, say) it is removed and the
    // page is told that the recording was NOT saved.
    void write_recording(const WriteJob& job) {
        namespace fs = std::filesystem;
        const fs::path dir(data_dir);
        std::string name = job.stamp + "__" + job.label + ".csv";
        std::error_code ec;
        for (int i = 2; i < 100 && fs::exists(dir / name, ec); i++)   // two recordings in the same second
            name = job.stamp + "__" + job.label + "_" + std::to_string(i) + ".csv";
        const fs::path final_path = dir / name, part_path = dir / (name + ".part");
        bool ok = false;
        {
            std::ofstream f(part_path);
            if (f) {
                f << "Robot NAME:" << (sim ? "Simulator" : "Inverse3") << "\n" << job.header;
                f << "Time(ms),Time(s),Unix_epoch(ns),X,Y,Z,VX,VY,VZ,f1,f2,f3,e1,e2,e3,ramp,loop_us,Index\n";
                // rows are formatted with snprintf into a 64 kB block, which is much faster than << for 600 000 rows
                std::vector<char> block(1 << 16);
                size_t used = 0;
                const int64_t t0 = job.rows ? rec_buf_[0].t_us : 0;
                for (size_t i = 0; i < job.rows && f; i++) {
                    const Row& r = rec_buf_[i];
                    if (block.size() - used < 512) { f.write(block.data(), (std::streamsize)used); used = 0; }
                    const int w = std::snprintf(block.data() + used, block.size() - used,
                        "%.7g,%.7g,%lld,%.7g,%.7g,%.7g,%.7g,%.7g,%.7g,%.7g,%.7g,%.7g,%.7g,%.7g,%.7g,%.7g,%.7g,%zu\n",
                        (double)(r.t_us - t0) / 1000.0, (double)(r.t_us - t0) / 1e6, (long long)r.unix_ns,
                        r.x[0], r.x[1], r.x[2], r.v[0], r.v[1], r.v[2], r.f[0], r.f[1], r.f[2], r.e[0], r.e[1], r.e[2],
                        r.ramp, r.loop_us, i);
                    if (w > 0) used += std::min((size_t)w, block.size() - used - 1);
                }
                f.write(block.data(), (std::streamsize)used);
                f.flush();
                ok = f.good();
                f.close();
                ok = ok && !f.fail();
            }
        }
        if (ok) { fs::rename(part_path, final_path, ec); ok = !ec; }
        if (!ok) fs::remove(part_path, ec);
        std::lock_guard<std::mutex> lock(file_mutex_);
        if (ok) { last_file_ = name; writer_msg_ = "recording saved: " + name; }
        else writer_msg_ = "recording NOT saved, write error (is the disk full?): " + name;
    }

    // ---------------------------------------------------------------- stopping
    // Zero force first (before anything that could take time), then the last recording, then a final state.
    void shutdown(const std::string& reason) {
        force_off_now();
        if (recording_) stop_recording("engine stopping");
        set_msg("engine stopped (" + reason + "): forces off");
        publish(now_t());
        printf("haply_lab_engine: stopped (%s), forces off\n", reason.c_str());
        fflush(stdout);
        stop_writer(true);                   // waits until an active recording is on disk, still publishing
        publish(now_t());                    // ... and tells the page whether it was saved
        g_cleanup_done = true;
    }

    // ---------------------------------------------------------------- state to the server
    void publish(double t) {
        std::string last_file, writer_msg;
        {
            std::lock_guard<std::mutex> lock(file_mutex_);
            last_file = last_file_;
            writer_msg.swap(writer_msg_);
        }
        if (!writer_msg.empty()) set_msg(writer_msg);
        const double rec_s = recording_ ? t - rec_t0_ : 0.0;
        std::ostringstream o;
        if (!token.empty()) o << token << ' ';   // the server drops state that does not start with the token
        o << std::fixed << std::setprecision(6);
        o << "{\"t\":" << t << ",\"x\":" << fmt3(x_) << ",\"v\":" << fmt3(v_) << ",\"f\":" << fmt3(F_, 4)
          << ",\"e\":" << fmt3(e_) << ",\"cal\":" << (calibrated_ ? "true" : "false")
          << ",\"connected\":" << ((sim || connected_) ? "true" : "false") << ",\"released\":" << (released_ ? "true" : "false")
          << ",\"sim\":" << (sim ? "true" : "false") << ",\"on\":" << (forces_ ? "true" : "false")
          << ",\"auth\":" << (token.empty() ? "false" : "true") << ",\"auth_drops\":" << auth_drops_
          << ",\"space_mb\":" << space_mb_.load()
          << ",\"rpy_now\":" << fmt3(scn_.rpy)
          << std::setprecision(3) << ",\"fmax_now\":" << fmax_
          << ",\"ramp\":" << ramp_ << ",\"hz\":" << loop_hz_ << ",\"rt_us\":" << exchange_us_
          << ",\"err\":" << errors_ << ",\"hb_age\":" << std::min(99.0, t - last_hb_)
          << ",\"rec\":" << (recording_ ? "true" : "false") << ",\"rec_s\":" << rec_s
          << ",\"rec_label\":\"" << json_escape(rec_label_) << "\",\"last_file\":\"" << json_escape(last_file) << "\""
          << ",\"dev\":\"" << (sim ? std::string("simulator") : connected_ ? std::to_string(haply_.device_id) : std::string("")) << "\""
          << ",\"rt\":\"" << json_escape(rt_info_) << "\""
          << ",\"msg\":\"" << json_escape(msg_) << "\",\"msg_id\":" << msg_id_
          << std::setprecision(6)
          << ",\"par\":{\"kind\":\"" << haptics::kind_name(scn_.kind) << "\",\"xd\":" << fmt3(xd_tgt_) << ",\"rpy\":" << fmt3(rpy_tgt_)
          << ",\"k\":" << fmt3(k_tgt_, 1) << ",\"b\":" << fmt3(b_tgt_, 3) << ",\"fmax\":" << fmax_tgt_
          << ",\"xd_now\":" << fmt3(scn_.x_d) << ",\"k_now\":" << fmt3(scn_.k, 1)
          << ",\"rpy_now\":" << fmt3(scn_.rpy) << ",\"fmax_now\":" << fmax_
          << ",\"fx\":\"" << json_escape(scn_.fx.source()) << "\",\"fy\":\"" << json_escape(scn_.fy.source())
          << "\",\"fz\":\"" << json_escape(scn_.fz.source()) << "\"}}";
        udp_.send(o.str());
    }
};

int main(int argc, char** argv) {
    install_stop_handlers();
    LabEngine eng;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
        if (a == "--sim") eng.sim = true;
        else if (a == "--port") eng.port = next();
        else if (a == "--data") eng.data_dir = next();
        else if (a == "--rate") eng.rate_hz = std::max(100.0, std::atof(next().c_str()));
        else if (a == "--state-port") eng.state_port = std::atoi(next().c_str());
        else if (a == "--cmd-port") eng.cmd_port = std::atoi(next().c_str());
        else if (a == "--parent-timeout") eng.parent_timeout = std::atof(next().c_str());
        else { printf("usage: haply_lab_engine [--sim] [--port P] [--data DIR] [--rate HZ] [--state-port N] [--cmd-port N] [--parent-timeout S]\n"
                      "       (set HAPLY_LAB_TOKEN in the environment to require a token on every command)\n"); return 1; }
    }
    if (!std::isfinite(eng.rate_hz)) eng.rate_hz = 1000.0;
    if (const char* tok = std::getenv("HAPLY_LAB_TOKEN")) eng.token = tok;
    if (!eng.token.empty()) {
        bool ok = eng.token.size() >= 16;
        for (char c : eng.token) if (c <= ' ' || c > '~') ok = false;
        if (!ok) {
            fprintf(stderr, "haply_lab_engine: HAPLY_LAB_TOKEN must be at least 16 printable ASCII characters, no spaces\n");
            return 2;
        }
    }
    int rc = 3;
    try {
        rc = eng.run();
    } catch (const std::exception& ex) {   // the destructors still send zero force and finish the writer
        fprintf(stderr, "haply_lab_engine: %s\n", ex.what());
    }
    g_cleanup_done = true;
    return rc;
}
