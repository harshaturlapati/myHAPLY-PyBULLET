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
// Safety layers, all in this file (the equations in myHAPLY_SCENARIOS.h stay pure maths):
//   * forces start OFF, need a calibrated device and a heartbeat less than 1 s old, and fade in over 1 s
//   * |F| <= fmax <= 4 N;  k <= 1000 N/m, b <= 15 N s/m per axis; the target point moves at most 0.1 m/s
//     and k, b change gradually, so dragging a slider never produces a jump
//   * forces switch off if |v| > 1.5 m/s (an unstable spring usually shows up as speed first)
//
// Usage:  haply_lab_engine [--sim] [--port COM5|/dev/haply] [--data DIR] [--rate 1000]
//                          [--state-port 47001] [--cmd-port 47002]

#include <myINCLUDES.h>
#include <myHAPLY_v1.h>
#include <myHAPLY_SCENARIOS.h>
#include <myUDP.h>

#include <algorithm>
#include <mutex>

#if defined(__linux__)
  #include <pthread.h>
  #include <sched.h>
  #include <sys/mman.h>
#endif

using haptics::Vec3;

namespace {

constexpr double K_MAX = 1000.0, B_MAX = 15.0, FMAX_HARD = 4.0, V_GUARD = 1.5;
constexpr double XD_RATE = 0.10;        // m/s       how fast the target point may move
constexpr double K_RATE = 2000.0;       // N/m/s     how fast stiffness may change
constexpr double B_RATE = 30.0;         // N s/m/s
constexpr double RPY_RATE = 1.0;        // rad/s
constexpr double RAMP_TIME = 1.0;       // s         forces fade in over this time
constexpr double HB_TIMEOUT = 1.0;      // s
constexpr double REC_MAX_S = 600.0;     // s         longest recording kept in memory

struct Row {
    int64_t t_us, unix_ns;
    float x[3], v[3], f[3], e[3];
    float ramp, loop_us;
};

std::string fmt3(const Vec3& a, int prec = 6) {
    char b[128];
    std::snprintf(b, sizeof(b), "[%.*f,%.*f,%.*f]", prec, a.x(), prec, a.y(), prec, a.z());
    return b;
}

std::string json_escape(const std::string& s) {
    std::string o;
    for (char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += c; }
        else if ((unsigned char)c < 0x20) o += ' ';
        else o += c;
    }
    return o;
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

}  // namespace

class LabEngine {
public:
    // options
    bool sim = false;
    std::string port, data_dir = "lab_data";
    double rate_hz = 1000.0;
    int state_port = 47001, cmd_port = 47002;
    double parent_timeout = 0;   // > 0: quit when the server has said nothing for this long (it sends "alive" every second)

    int run() {
        my::HighResTimer high_res_timer;
        (void)high_res_timer;
        if (!udp_.open(cmd_port, "127.0.0.1", state_port)) {
            fprintf(stderr, "Cannot open UDP port %d (is another engine running?)\n", cmd_port);
            return 1;
        }
        std::error_code ec;
        std::filesystem::create_directories(data_dir, ec);
        rt_info_ = realtime_setup();
        printf("haply_lab_engine: %s mode, %.0f Hz, %s\n", sim ? "SIMULATOR" : "device", rate_hz, rt_info_.c_str());
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

        while (!quit_) {
            // 1. commands from the server (never blocks)
            std::string m;
            while (udp_.recv(m)) handle(m);

            const auto now = my::Clock::now();
            const double t = std::chrono::duration<double>(now - t0_).count();
            if (parent_timeout > 0 && t - last_cmd_ > parent_timeout) {
                printf("haply_lab_engine: no message from the server for %.0f s - stopping\n", parent_timeout);
                break;
            }

            // 2. keep the device connected (device mode)
            if (!sim && !connected_ && !released_ && now >= t_retry) {
                t_retry = now + std::chrono::seconds(2);
                haply_.port = port;
                haply_.timeout_ms = 20;
                haply_.F_max = (float)FMAX_HARD;   // the engine's own clamp (fmax <= 4 N) is the one that counts
                if (haply_.connect()) { connected_ = true; set_msg("Inverse3 connected on " + haply_.port); }
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
                    loop_hz_ = rate_count / std::chrono::duration<double>(now - t_rate).count();
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
        }

        // leave the device with zero force
        if (connected_) haply_.quick_stop();
        if (recording_) stop_recording();
        if (writer_.joinable()) writer_.join();
        return 0;
    }

private:
    my::UdpSocket udp_;
    myHAPLY haply_{"Inverse3"};
    bool connected_ = false, released_ = false, quit_ = false;
    std::string rt_info_;
    my::Clock::time_point t0_;

    // scenario: what the student asked for (target) and what is applied now (rate-limited)
    haptics::Scenario scn_;
    Vec3 xd_tgt_ = Vec3::Zero(), rpy_tgt_ = Vec3::Zero(), k_tgt_ = Vec3::Zero(), b_tgt_ = Vec3::Zero();
    double fmax_ = 2.0;

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

    // recording
    bool recording_ = false;
    std::string rec_label_, rec_header_;
    std::vector<Row> rec_;
    double rec_t0_ = 0;
    std::thread writer_;
    std::string last_file_;
    std::mutex file_mutex_;

    void set_msg(const std::string& s) { msg_ = s; msg_id_++; }

    void cycle(double t, double dt) {
        // --- parameters move smoothly towards what was asked
        scn_.x_d = step_towards(scn_.x_d, xd_tgt_, XD_RATE * dt);
        scn_.k = step_each(scn_.k, k_tgt_, K_RATE * dt);
        scn_.b = step_each(scn_.b, b_tgt_, B_RATE * dt);
        scn_.rpy = step_each(scn_.rpy, rpy_tgt_, RPY_RATE * dt);

        // --- force from the scenario equation, using the latest position and velocity
        Vec3 F = Vec3::Zero();
        haptics::Detail det;
        const Vec3 F_eq = haptics::force(scn_, x_, v_, t, &det);
        e_ = det.e;
        if (forces_) {
            if (!calibrated_) { forces_ = false; set_msg("forces off: the device is not calibrated"); }
            else if (t - last_hb_ > HB_TIMEOUT) { forces_ = false; set_msg("forces off: the page stopped answering (watchdog)"); }
            else if (v_.norm() > V_GUARD) {
                forces_ = false;
                char b[120];
                std::snprintf(b, sizeof(b), "forces off: speed guard, |v| = %.2f m/s (limit %.1f). Lower k or raise b.", v_.norm(), V_GUARD);
                set_msg(b);
            }
        }
        if (forces_) {
            ramp_ = std::min(1.0, ramp_ + dt / RAMP_TIME);
            F = ramp_ * F_eq;
            if (!F.allFinite()) F.setZero();
            const double n = F.norm();
            if (n > fmax_) F *= fmax_ / n;
        } else {
            ramp_ = 0.0;
        }

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
                if (haply_.consecutive_errors > 50) {
                    connected_ = false;
                    forces_ = false;
                    haply_.disconnect();
                    set_msg("lost the Inverse3 (" + haply_.last_error + "); retrying");
                }
            }
        }
        F_ = F;

        // --- record at the full rate
        if (recording_) {
            if (rec_.size() < rec_.capacity()) {
                Row r;
                r.t_us = my::tick_us();
                r.unix_ns = my::unix_ns();
                for (int i = 0; i < 3; i++) { r.x[i] = (float)x_[i]; r.v[i] = (float)v_[i]; r.f[i] = (float)F[i]; r.e[i] = (float)e_[i]; }
                r.ramp = (float)ramp_;
                r.loop_us = exchange_us_;
                rec_.push_back(r);
            } else {
                stop_recording();
                set_msg("recording stopped: maximum length reached");
            }
        }
    }

    void sim_step(double t, double dt, const Vec3& F) {
        // the hand follows a slow figure-eight, or the point dragged on the page
        if (t < sim_target_until_) hand_ = step_towards(hand_, sim_target_, 0.5 * dt);
        else {
            const double w = 2 * 3.14159265358979 * 0.12;
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
        const double t = std::chrono::duration<double>(my::Clock::now() - t0_).count();
        last_cmd_ = t;
        if (cmd == "alive") return;
        if (cmd == "hb") { last_hb_ = t; return; }
        if (cmd == "forces") {
            int on = 0;
            in >> on;
            if (on && !calibrated_) { set_msg("cannot switch forces on: the device is not calibrated"); return; }
            if (on && t - last_hb_ > HB_TIMEOUT) { set_msg("cannot switch forces on: no heartbeat from the page"); return; }
            if (on && !forces_) { ramp_ = 0; set_msg("forces ON (fading in over 1 s)"); }
            if (!on && forces_) set_msg("forces off");
            forces_ = on != 0;
            return;
        }
        if (cmd == "set") {
            std::string what;
            in >> what;
            if (what == "kind") {
                std::string k;
                in >> k;
                haptics::Kind kind;
                if (!haptics::kind_from_name(k, kind)) { set_msg("unknown scenario '" + k + "'"); return; }
                if (kind != scn_.kind) { scn_.kind = kind; ramp_ = 0; set_msg(std::string("scenario: ") + k); }
                return;
            }
            if (what == "fmax") {
                double f = 2;
                in >> f;
                fmax_ = std::clamp(f, 0.0, FMAX_HARD);
                return;
            }
            double a = 0, b = 0, c = 0;
            if (!(in >> a >> b >> c) || !std::isfinite(a) || !std::isfinite(b) || !std::isfinite(c)) {
                set_msg("'set " + what + "' needs three numbers");
                return;
            }
            const Vec3 v3(a, b, c);
            if (what == "xd") xd_tgt_ = v3.cwiseMax(Vec3::Constant(-0.3)).cwiseMin(Vec3::Constant(0.3));
            else if (what == "rpy") rpy_tgt_ = v3;
            else if (what == "k") k_tgt_ = v3.cwiseMax(Vec3::Zero()).cwiseMin(Vec3::Constant(K_MAX));
            else if (what == "b") b_tgt_ = v3.cwiseMax(Vec3::Zero()).cwiseMin(Vec3::Constant(B_MAX));
            else set_msg("unknown parameter '" + what + "'");
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
            if (text.empty() || text == "0") { e->clear(); if (scn_.kind == haptics::Kind::Custom) ramp_ = 0; return; }
            std::string err;
            if (!e->compile(text, err)) { set_msg(axis + ": " + err); return; }
            if (scn_.kind == haptics::Kind::Custom) ramp_ = 0;
            set_msg(axis + " = " + text);
            return;
        }
        if (cmd == "rec") {
            std::string what, label;
            in >> what;
            std::getline(in, label);
            if (what == "start") start_recording(label);
            else if (what == "stop") stop_recording();
            return;
        }
        if (cmd == "sim") {
            double a = 0, b = 0, c = 0;
            if (in >> a >> b >> c) { sim_target_ = Vec3(a, b, c); sim_target_until_ = t + 1.5; }
            return;
        }
        if (cmd == "device") {
            std::string what;
            in >> what;
            if (what == "release" && !sim) {
                forces_ = false;
                if (connected_) haply_.quick_stop();
                connected_ = false;
                released_ = true;
                set_msg("device released: other programs can use it now");
            } else if (what == "acquire") {
                released_ = false;
                set_msg("taking the device back...");
            }
            return;
        }
        if (cmd == "quit") { quit_ = true; return; }
        set_msg("unknown command '" + cmd + "'");
    }

    // ---------------------------------------------------------------- recording
    void start_recording(std::string label) {
        if (recording_) { set_msg("already recording '" + rec_label_ + "': stop it first"); return; }
        std::string clean;
        for (char c : label) if (std::isalnum((unsigned char)c) || c == '-' || c == '_') clean += c; else if (c == ' ' && !clean.empty()) clean += '_';
        if (clean.size() > 60) clean.resize(60);
        rec_label_ = clean.empty() ? "experiment" : clean;
        rec_.clear();
        rec_.reserve((size_t)(REC_MAX_S * rate_hz));
        rec_header_ = scenario_comment();
        rec_t0_ = std::chrono::duration<double>(my::Clock::now() - t0_).count();
        recording_ = true;
        set_msg("recording '" + rec_label_ + "'");
    }

    std::string scenario_comment() const {
        std::ostringstream o;
        o << "# myHAPLY lab recording, " << (sim ? "SIMULATOR" : "Inverse3") << ", " << rate_hz << " Hz\n";
        o << "# scenario: kind=" << haptics::kind_name(scn_.kind) << " xd=" << fmt3(xd_tgt_) << " rpy=" << fmt3(rpy_tgt_)
          << " k=" << fmt3(k_tgt_, 1) << " b=" << fmt3(b_tgt_, 2) << " fmax=" << fmax_ << "\n";
        if (scn_.kind == haptics::Kind::Custom)
            o << "# expr: fx=" << scn_.fx.source() << " ; fy=" << scn_.fy.source() << " ; fz=" << scn_.fz.source() << "\n";
        o << "# columns: X,Y,Z m; VX,VY,VZ m/s; f1..f3 force sent (N); e1..e3 error x_d-x in the target frame (m); "
             "ramp 0..1; loop_us device round trip\n";
        return o.str();
    }

    void stop_recording() {
        if (!recording_) return;
        recording_ = false;
        if (writer_.joinable()) writer_.join();
        const std::string path = (std::filesystem::path(data_dir) / (my::timestamp_string() + "__" + rec_label_ + ".csv")).string();
        // write in a low-priority thread so the 1 kHz loop never waits for the disk
        writer_ = std::thread([this, rows = std::move(rec_), header = rec_header_, path]() {
            lower_this_thread_priority();
            std::ofstream f(path);
            f << "Robot NAME:" << (sim ? "Simulator" : "Inverse3") << "\n" << header;
            f << "Time(ms),Time(s),Unix_epoch(ns),X,Y,Z,VX,VY,VZ,f1,f2,f3,e1,e2,e3,ramp,loop_us,Index\n";
            f << std::setprecision(7);
            const int64_t t0 = rows.empty() ? 0 : rows[0].t_us;
            for (size_t i = 0; i < rows.size(); i++) {
                const Row& r = rows[i];
                f << (r.t_us - t0) / 1000.0 << "," << (r.t_us - t0) / 1e6 << "," << r.unix_ns;
                for (float v : r.x) f << "," << v;
                for (float v : r.v) f << "," << v;
                for (float v : r.f) f << "," << v;
                for (float v : r.e) f << "," << v;
                f << "," << r.ramp << "," << r.loop_us << "," << i << "\n";
            }
            std::lock_guard<std::mutex> lock(file_mutex_);
            last_file_ = std::filesystem::path(path).filename().string();
        });
        rec_ = std::vector<Row>();
        set_msg("recording saved");
    }

    // ---------------------------------------------------------------- state to the server
    void publish(double t) {
        std::string last_file;
        {
            std::lock_guard<std::mutex> lock(file_mutex_);
            last_file = last_file_;
        }
        const double rec_s = recording_ ? t - rec_t0_ : 0.0;
        std::ostringstream o;
        o << std::fixed << std::setprecision(6);
        o << "{\"t\":" << t << ",\"x\":" << fmt3(x_) << ",\"v\":" << fmt3(v_) << ",\"f\":" << fmt3(F_, 4)
          << ",\"e\":" << fmt3(e_) << ",\"cal\":" << (calibrated_ ? "true" : "false")
          << ",\"connected\":" << ((sim || connected_) ? "true" : "false") << ",\"released\":" << (released_ ? "true" : "false")
          << ",\"sim\":" << (sim ? "true" : "false") << ",\"on\":" << (forces_ ? "true" : "false")
          << std::setprecision(3) << ",\"ramp\":" << ramp_ << ",\"hz\":" << loop_hz_ << ",\"rt_us\":" << exchange_us_
          << ",\"err\":" << errors_ << ",\"hb_age\":" << std::min(99.0, t - last_hb_)
          << ",\"rec\":" << (recording_ ? "true" : "false") << ",\"rec_s\":" << rec_s
          << ",\"rec_label\":\"" << json_escape(rec_label_) << "\",\"last_file\":\"" << json_escape(last_file) << "\""
          << ",\"dev\":\"" << (sim ? std::string("simulator") : connected_ ? std::to_string(haply_.device_id) : std::string("")) << "\""
          << ",\"rt\":\"" << json_escape(rt_info_) << "\""
          << ",\"msg\":\"" << json_escape(msg_) << "\",\"msg_id\":" << msg_id_
          << std::setprecision(6)
          << ",\"par\":{\"kind\":\"" << haptics::kind_name(scn_.kind) << "\",\"xd\":" << fmt3(xd_tgt_) << ",\"rpy\":" << fmt3(rpy_tgt_)
          << ",\"k\":" << fmt3(k_tgt_, 1) << ",\"b\":" << fmt3(b_tgt_, 3) << ",\"fmax\":" << fmax_
          << ",\"xd_now\":" << fmt3(scn_.x_d) << ",\"k_now\":" << fmt3(scn_.k, 1)
          << ",\"fx\":\"" << json_escape(scn_.fx.source()) << "\",\"fy\":\"" << json_escape(scn_.fy.source())
          << "\",\"fz\":\"" << json_escape(scn_.fz.source()) << "\"}}";
        udp_.send(o.str());
    }
};

int main(int argc, char** argv) {
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
        else { printf("usage: haply_lab_engine [--sim] [--port P] [--data DIR] [--rate HZ] [--state-port N] [--cmd-port N] [--parent-timeout S]\n"); return 1; }
    }
    return eng.run();
}
