// myHAPLY_LOGGING.h - preallocated in-memory log, written to CSV after the loop.
// Same idea as myVIRTUOSE_LOGGING.h (myVIRTUOSE_LOG + myWRITE_VIRT_LOG): nothing touches the disk
// inside the control loop, so logging never slows the 1 kHz loop down. Portable (no Shlwapi).
#pragma once

#include "myINCLUDES.h"

struct HaplyLogRow {
    int64_t t_us = 0;          // monotonic time (us)
    int64_t unix_ns = 0;       // wall-clock time (ns since 1970)
    float pos[3] = {0, 0, 0};  // end-effector position (m), device frame
    float vel[3] = {0, 0, 0};  // end-effector velocity (m/s)
    float f_cmd[3] = {0, 0, 0};// force sent to the device this cycle (N)
    float udp_f[6] = {0, 0, 0, 0, 0, 0};  // spare channels (UDP / PyBullet inputs in later examples)
    float loop_us = 0;         // duration of this cycle's device exchange (us)
};

class myHAPLY_LOG {
public:
    // duration_s seconds at rate_hz samples per second are preallocated; extra samples are dropped.
    myHAPLY_LOG(double duration_s, double rate_hz = 1000.0)
        : rows_((size_t)(duration_s * rate_hz) + 1) {}

    bool write2LOG(const HaplyLogRow& r) {
        if (count_ >= rows_.size()) { dropped_++; return false; }
        rows_[count_++] = r;
        return true;
    }

    size_t size() const { return count_; }
    size_t dropped() const { return dropped_; }
    const HaplyLogRow& operator[](size_t i) const { return rows_[i]; }

    // Writes <folder>/haply_log_file__<name>_<YYYY_MM_DD_HHMMSS>.csv and returns its path.
    std::string write2FILE(const std::string& name, const std::string& folder = "logs") const {
        namespace fs = std::filesystem;
        std::error_code ec;
        fs::create_directories(folder, ec);
        fs::path path = fs::path(folder) / ("haply_log_file__" + name + "_" + my::timestamp_string() + ".csv");
        std::ofstream f(path);
        if (!f) { std::cerr << "Could not write " << path.string() << "\n"; return ""; }
        f << "Robot NAME:" << name << "\n";
        f << "Time(ms),Time(s),Unix_epoch(ns),"
          << "X,Y,Z,VX,VY,VZ,"
          << "f1,f2,f3,"
          << "UDP_f1,UDP_f2,UDP_f3,UDP_f4,UDP_f5,UDP_f6,"
          << "loop_us,Index\n";
        f << std::setprecision(9);
        const int64_t t0 = count_ ? rows_[0].t_us : 0;
        for (size_t i = 0; i < count_; ++i) {
            const auto& r = rows_[i];
            f << (r.t_us - t0) / 1000.0 << "," << (r.t_us - t0) / 1e6 << "," << r.unix_ns << ",";
            for (float v : r.pos) f << v << ",";
            for (float v : r.vel) f << v << ",";
            for (float v : r.f_cmd) f << v << ",";
            for (float v : r.udp_f) f << v << ",";
            f << r.loop_us << "," << i << "\n";
        }
        std::cout << "Wrote " << count_ << " samples to " << fs::absolute(path).string() << "\n";
        if (dropped_) std::cout << "(" << dropped_ << " samples after the preallocated duration were not logged)\n";
        return path.string();
    }

private:
    std::vector<HaplyLogRow> rows_;
    size_t count_ = 0, dropped_ = 0;
};
