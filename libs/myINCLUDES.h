// myINCLUDES.h - common includes + small OS helpers for myHAPLY-PyBULLET.
// Works on Windows (MSVC) and Linux / Raspberry Pi OS (GCC). Replaces the Windows-only
// myINCLUDES.h of myVIRTUOSE-PyBULLET: no <conio.h>, GetKeyState or Sleep() in example code.
#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #include <windows.h>
  #include <conio.h>
  #include <timeapi.h>
  #pragma comment(lib, "winmm.lib")
#else
  #include <fcntl.h>
  #include <sys/select.h>
  #include <termios.h>
  #include <unistd.h>
#endif

namespace my {

using Clock = std::chrono::steady_clock;

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

// Microseconds on a monotonic clock (same role as GetTickUs() in myVIRTUOSE_LOGGING.h)
inline int64_t tick_us() {
    return std::chrono::duration_cast<std::chrono::microseconds>(Clock::now().time_since_epoch()).count();
}

// Wall-clock Unix time in nanoseconds (for aligning logs from several machines)
inline int64_t unix_ns() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}

// Windows sleeps in 15.6 ms steps unless the timer resolution is raised. Create one of these
// at the top of main(); it restores the default when it goes out of scope.
struct HighResTimer {
#if defined(_WIN32)
    HighResTimer() { timeBeginPeriod(1); }
    ~HighResTimer() { timeEndPeriod(1); }
#endif
};

// Sleep until an absolute time point: coarse sleep, then a short spin for the last ~0.3 ms.
// Keeps a 1 kHz loop on time on both Windows and Linux (never use Sleep(0.001f): it is Sleep(0)).
inline void sleep_until(Clock::time_point t) {
    const auto spin = std::chrono::microseconds(300);
    auto now = Clock::now();
    if (t - now > spin) std::this_thread::sleep_for(t - now - spin);
    while (Clock::now() < t) { std::this_thread::yield(); }
}

// Local date-time string, e.g. 2026_11_26_143005
inline std::string timestamp_string() {
    std::time_t now = std::time(nullptr);
    std::tm tm_local{};
#if defined(_WIN32)
    localtime_s(&tm_local, &now);
#else
    localtime_r(&now, &tm_local);
#endif
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y_%m_%d_%H%M%S", &tm_local);
    return buf;
}

// ---------------------------------------------------------------------------------------------
// Stopping a loop: press Q (or q) in the terminal, or Ctrl+C. Works over SSH on the Pi too.
// ---------------------------------------------------------------------------------------------

inline std::atomic<bool>& stop_flag() {
    static std::atomic<bool> flag{false};
    return flag;
}

class QuitKey {
public:
    QuitKey() {
        std::signal(SIGINT, [](int) { stop_flag() = true; });
#if !defined(_WIN32)
        // Put the terminal in non-canonical, no-echo mode so a single key press is seen at once.
        if (isatty(STDIN_FILENO) && tcgetattr(STDIN_FILENO, &old_) == 0) {
            termios raw = old_;
            raw.c_lflag &= ~(ICANON | ECHO);
            raw.c_cc[VMIN] = 0;
            raw.c_cc[VTIME] = 0;
            tcsetattr(STDIN_FILENO, TCSANOW, &raw);
            restore_ = true;
        }
#endif
    }
    ~QuitKey() {
#if !defined(_WIN32)
        if (restore_) tcsetattr(STDIN_FILENO, TCSANOW, &old_);
#endif
    }
    // True once Q/q (or Ctrl+C) has been pressed. Cheap enough to call every loop iteration.
    bool pressed() {
        if (stop_flag()) return true;
#if defined(_WIN32)
        while (_kbhit()) {
            int c = _getch();
            if (c == 'q' || c == 'Q' || c == 27) stop_flag() = true;
        }
#else
        if (restore_) {
            fd_set fds;
            FD_ZERO(&fds);
            FD_SET(STDIN_FILENO, &fds);
            timeval tv{0, 0};
            if (select(STDIN_FILENO + 1, &fds, nullptr, nullptr, &tv) > 0) {
                char c = 0;
                if (read(STDIN_FILENO, &c, 1) == 1 && (c == 'q' || c == 'Q' || c == 27)) stop_flag() = true;
            }
        }
#endif
        return stop_flag();
    }

private:
#if !defined(_WIN32)
    termios old_{};
    bool restore_ = false;
#endif
};

}  // namespace my
