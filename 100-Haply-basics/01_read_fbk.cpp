// 01_read_fbk.cpp - read feedback from the Haply Inverse3, print it on the terminal and log it to CSV.
//
// The Haply version of 200-Single-arm/01-virtuose_bullet_wLOGGING_v1.cpp (myVIRTUOSE-PyBULLET):
// same structure (device object -> quick_start -> loop until Q -> write log -> quick_stop), but
// read-only: the force sent every cycle is zero, so the device never pushes on your hand.
//
// Usage:   01_read_fbk [--port COM5|/dev/haply] [--rate 1000] [--seconds 0] [--log-seconds 120] [--print-hz 20] [--timeout-ms 20]
//   --rate        loop rate in Hz (0 = as fast as the device answers)
//   --seconds     stop after this many seconds (0 = run until Q / Ctrl+C)
//   --log-seconds how many seconds of samples to keep for the CSV (preallocated, like myVIRTUOSE_LOG)
//   --print-hz    how often the terminal line is refreshed
//   --timeout-ms  per-reply device timeout in milliseconds (a healthy reply takes ~0.1 ms)
// The CSV goes to ./logs/haply_log_file__Inverse3_<date>.csv

#include <myINCLUDES.h>         // portable includes, timing, Q-to-quit
#include <myHAPLY_v1.h>         // Haply Inverse3 class (direct USB serial, any OS)
#include <myHAPLY_LOGGING.h>    // preallocated logger + CSV writer

#include <algorithm>

static void print_usage() {
    printf("01_read_fbk [--port PORT] [--rate HZ] [--seconds S] [--log-seconds S] [--print-hz HZ] [--timeout-ms MS]\n");
}

int main(int argc, char** argv)
{
    // ----------------------------------------------------------------------------------------
    // Options
    // ----------------------------------------------------------------------------------------
    std::string port = "";           // "" = auto-detect (/dev/haply on the lab Pi)
    double rate_hz = 1000.0;         // loop rate
    double run_s = 0.0;              // 0 = until Q
    double log_s = 120.0;            // CSV capacity
    double print_hz = 20.0;          // terminal refresh rate
    double timeout_ms = 20;          // per-reply device timeout (ms)
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto next = [&](double& v) { if (i + 1 < argc) v = std::atof(argv[++i]); };
        if (a == "--port" && i + 1 < argc) port = argv[++i];
        else if (a == "--rate") next(rate_hz);
        else if (a == "--seconds") next(run_s);
        else if (a == "--log-seconds") next(log_s);
        else if (a == "--print-hz") next(print_hz);
        else if (a == "--timeout-ms") next(timeout_ms);
        else if (a == "-h" || a == "--help") { print_usage(); return 0; }
        else { printf("Unknown option %s\n", a.c_str()); print_usage(); return 1; }
    }

    my::HighResTimer high_res_timer;  // 1 ms sleep resolution on Windows
    (void)high_res_timer;
    my::QuitKey quit;                 // Q or Ctrl+C ends the loop

    // ----------------------------------------------------------------------------------------
    // Haply object definition
    // ----------------------------------------------------------------------------------------
    myHAPLY Haply("Inverse3", port);
    Haply.timeout_ms = (int)timeout_ms;
    if (!Haply.quick_start()) {   // always needs to be done
        return 1;
    }

    // Initialising logger
    myHAPLY_LOG Haply_LOG(log_s, rate_hz > 0 ? rate_hz : 4000.0);

    // ----------------------------------------------------------------------------------------
    // Loop
    // ----------------------------------------------------------------------------------------
    const auto period = std::chrono::duration_cast<my::Clock::duration>(
        std::chrono::duration<double>(rate_hz > 0 ? 1.0 / rate_hz : 0.0));
    const auto print_period = std::chrono::duration_cast<my::Clock::duration>(
        std::chrono::duration<double>(1.0 / std::max(print_hz, 0.1)));

    std::vector<float> exchange_us;   // for the timing summary
    exchange_us.reserve((size_t)(std::max(log_s, 1.0) * std::max(rate_hz, 1000.0)));

    long long data_count = 0, late = 0;
    const auto t_start = my::Clock::now();
    auto t_next = t_start;
    auto t_print = t_start;
    long long count_at_print = 0;
    double shown_hz = 0.0;

    printf("\nStreaming feedback at %s. Press Q to exit loop (or Ctrl+C).\n",
           rate_hz > 0 ? (std::to_string((int)rate_hz) + " Hz").c_str() : "full speed");

    while (!quit.pressed()) {

        // Query Haply state: F_cmd is zero in this example, so this is a pure feedback read.
        const bool ok = Haply.render_F_cmd();

        // Write to log
        HaplyLogRow row;
        row.t_us = my::tick_us();
        row.unix_ns = my::unix_ns();
        for (int i = 0; i < 3; i++) {
            row.pos[i] = Haply.X[i];
            row.vel[i] = Haply.V[i];
            row.f_cmd[i] = Haply.F_sent[i];
        }
        row.loop_us = Haply.last_exchange_us;
        Haply_LOG.write2LOG(row);
        if (exchange_us.size() < exchange_us.capacity()) exchange_us.push_back(Haply.last_exchange_us);

        if (!ok && Haply.consecutive_errors >= 100) {
            fprintf(stderr, "\n100 failed exchanges in a row: the device stopped answering (unplugged?).\n");
            break;
        }

        data_count++;

        // Print a single refreshing line, a few times per second (printing every cycle would slow the loop)
        const auto now = my::Clock::now();
        if (now - t_print >= print_period) {
            const double dt = std::chrono::duration<double>(now - t_print).count();
            shown_hz = (data_count - count_at_print) / dt;
            count_at_print = data_count;
            t_print = now;
            const double t = std::chrono::duration<double>(now - t_start).count();
            printf("\rt=%8.2f s  X=[% .4f % .4f % .4f] m  V=[% .3f % .3f % .3f] m/s  %6.0f Hz  %s   ",
                   t, Haply.X[0], Haply.X[1], Haply.X[2], Haply.V[0], Haply.V[1], Haply.V[2], shown_hz,
                   !ok ? "ERR" : Haply.calibrated ? "" : "NOT CALIBRATED (dock it until the LED changes)");
            fflush(stdout);
        }

        if (run_s > 0 && std::chrono::duration<double>(now - t_start).count() >= run_s) break;

        // Keep the loop on its schedule (replaces Sleep(delta_t) of the Virtuose code)
        if (rate_hz > 0) {
            t_next += period;
            if (t_next < now) {          // fell behind: count it, and don't try to catch up in a burst
                late++;
                t_next = now;
            } else {
                my::sleep_until(t_next);
            }
        }
    }
    printf("\n");

    // ----------------------------------------------------------------------------------------
    // Summary + clean up
    // ----------------------------------------------------------------------------------------
    const double elapsed = std::chrono::duration<double>(my::Clock::now() - t_start).count();
    printf("\n%lld samples in %.2f s = %.1f Hz (target %s), %lld late cycles, %lld device errors\n",
           data_count, elapsed, data_count / std::max(elapsed, 1e-9),
           rate_hz > 0 ? std::to_string((int)rate_hz).c_str() : "max", late, Haply.n_errors);
    if (!exchange_us.empty()) {
        std::vector<float> s = exchange_us;
        std::sort(s.begin(), s.end());
        double mean = 0;
        for (float v : s) mean += v;
        mean /= s.size();
        printf("device round trip (send force + receive state): mean %.0f us, median %.0f us, p99 %.0f us, max %.0f us\n",
               mean, s[s.size() / 2], s[(size_t)(s.size() * 0.99)], s.back());
    }

    Haply.quick_stop();
    Haply_LOG.write2FILE(Haply.name);

    return 0;
}
