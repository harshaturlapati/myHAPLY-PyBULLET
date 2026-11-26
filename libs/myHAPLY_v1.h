// myHAPLY_v1.h - Haply Inverse3 device class (the Haply counterpart of myVIRTUOSE_v4.h).
//
// Talks to the Inverse3 directly over its USB serial port: no Haply Inverse Service, no WebSocket, no
// closed-source library. Header-only, standard C++17 + mySERIAL.h, so it builds on Windows, Linux,
// Raspberry Pi and macOS alike. Every exchange sends one force command and gets back the cursor position
// and velocity - the fastest round trip the device offers (~0.1 ms; several kHz possible).
//
//   myHAPLY Haply("Inverse3");        // or myHAPLY Haply("Inverse3", "/dev/haply") / ("Inverse3", "COM5")
//   Haply.quick_start();              // find port, open, wake up, print device info, sanity check
//   Haply.F_cmd[2] = 0.5f;            // (later examples) force to render, newtons
//   Haply.render_F_cmd();             // clamp + send F_cmd, update X and V, reset F_cmd to zero
//   Haply.quick_stop();               // zero force, close the port
//
// Wire protocol (binary, little-endian float32), as used by Haply's HardwareAPI and seen on firmware 7.10:
//   wake-up        host 0x0A                      device 0x0B + u16 id + 3 x u8 + 16-byte UUID   (22 bytes)
//   cursor force   host 0x2A + fx fy fz (N)       device 0x2B + x y z (m) + vx vy vz (m/s)        (25 bytes)
//   joint torque   host 0x1A + t1 t2 t3 (Nm)      device 0x1B + q1 q2 q3 (deg) + w1 w2 w3 (deg/s) (25 bytes)
//   status event   device only: 0xBA + type + length + payload  (e.g. BA 11 02 40 43 when the mode changes)
// Firmware 7.x sends status events before or after replies at any time; read_reply() skips them. (Haply's
// legacy HardwareAPI 0.2.8 does not, and stalls for a second each time one arrives first.)
//
// Frames and units: X (m) and V (m/s) are the cursor position/velocity in the device frame.
// The cursor position only exists after calibration (see print_calibration_help()).
#pragma once

#include "myINCLUDES.h"
#include "mySERIAL.h"

class myHAPLY {
public:
    // ---- Protocol constants --------------------------------------------------------------------
    static constexpr uint16_t USB_VID = 0x16C0, USB_PID = 0x0483;   // Teensy (shared by every Teensy board)
    static constexpr uint8_t CMD_WAKEUP = 0x0A, RSP_WAKEUP = 0x0B;
    static constexpr uint8_t CMD_JOINT_TORQUES = 0x1A, RSP_JOINT_STATES = 0x1B;
    static constexpr uint8_t CMD_CURSOR_FORCE = 0x2A, RSP_CURSOR_STATE = 0x2B;
    static constexpr uint8_t EVT_STATUS = 0xBA;

    std::string name;                 // used in log file names
    std::string port;                 // "" = auto-detect

    // Feedback, updated by every exchange
    float X[3] = {0.0f, 0.0f, 0.0f};  // cursor position (m)
    float V[3] = {0.0f, 0.0f, 0.0f};  // cursor velocity (m/s)

    // Force command: set it, then render_F_cmd(). Reset to zero after each send, like W_cmd in myVIRTUOSE.
    float F_cmd[3] = {0.0f, 0.0f, 0.0f};
    float F_sent[3] = {0.0f, 0.0f, 0.0f};   // what was actually sent after the safety clamp
    float F_max = 3.0f;                     // safety clamp on |F| (N); raise deliberately, not by accident

    // Raw joint feedback (degrees, deg/s) from queryJOINTS(); valid even before calibration
    float q[3] = {0.0f, 0.0f, 0.0f};
    float qdot[3] = {0.0f, 0.0f, 0.0f};

    // Device information (filled by connect)
    uint16_t device_id = 0;
    uint8_t info_bytes[3] = {0, 0, 0};      // model / hardware / firmware bytes of the wake-up reply (legacy meaning)
    std::string uuid;
    // Until the device is calibrated, firmware 7.x returns X = 0 and V = 65535 (no cursor position yet).
    bool calibrated = false;
    uint8_t last_status[2] = {0, 0};        // payload of the latest status event
    long long n_status_events = 0;

    // Diagnostics
    float last_exchange_us = 0.0f;          // duration of the last send+receive
    long long n_exchanges = 0, n_errors = 0;
    int consecutive_errors = 0;
    std::string last_error;

    int timeout_ms = 20;                    // per-reply timeout; a healthy reply takes ~0.1 ms

    explicit myHAPLY(std::string name_in = "Inverse3", std::string port_in = "")
        : name(std::move(name_in)), port(std::move(port_in)) {}

    ~myHAPLY() { quick_stop(); }

    // ---- Connection ----------------------------------------------------------------------------

    bool connect() {
        std::vector<std::string> candidates;
        if (!port.empty()) candidates.push_back(port);
        else {
            printf("Looking for an Inverse3 (USB %04x:%04x)...\n", USB_VID, USB_PID);
            candidates = my::find_usb_serial_ports(USB_VID, USB_PID);
        }
        for (const auto& p : candidates) {
            printf("Trying %s\n", p.c_str());
            if (!serial_.open(p)) { printf("  %s\n", serial_.last_error().c_str()); continue; }
            if (wakeup()) { port = p; return true; }
            printf("  no Inverse3 answer on %s\n", p.c_str());
            serial_.close();
        }
        fprintf(stderr,
                "No Inverse3 found. Check the USB cable, then:\n"
                "  Linux/Pi : ls -l /dev/haply /dev/ttyACM*   (your user must be in group 'dialout')\n"
                "  Windows  : Device Manager > Ports (COM & LPT). Only one program can open the port:\n"
                "             close Haply Hub and stop the Haply Inverse Service if they are running.\n"
                "Or pass the port explicitly:  --port COM5   /   --port /dev/ttyACM0\n");
        return false;
    }

    void disconnect() { serial_.close(); }
    bool is_connected() const { return serial_.is_open(); }

    // ---- Exchanges -----------------------------------------------------------------------------

    // One round trip: send force f (N), receive X (m) and V (m/s). Returns false on a device error.
    bool exchange(const float f[3]) {
        if (!serial_.is_open()) return false;
        const auto t0 = my::Clock::now();
        uint8_t tx[13];
        tx[0] = CMD_CURSOR_FORCE;
        std::memcpy(tx + 1, f, 12);
        float rx[6];
        const bool ok = serial_.write_all(tx, sizeof(tx)) && read_reply(RSP_CURSOR_STATE, rx, 6);
        last_exchange_us = std::chrono::duration<float, std::micro>(my::Clock::now() - t0).count();
        n_exchanges++;
        if (!ok) { n_errors++; consecutive_errors++; resync(); return false; }
        consecutive_errors = 0;
        for (int i = 0; i < 3; i++) { X[i] = rx[i]; V[i] = rx[3 + i]; }
        calibrated = !(V[0] >= 65000.0f && V[1] >= 65000.0f && V[2] >= 65000.0f);
        return true;
    }

    // Read feedback without applying force.
    bool queryPOS() {
        const float zero[3] = {0.0f, 0.0f, 0.0f};
        for (int i = 0; i < 3; i++) F_sent[i] = 0.0f;
        return exchange(zero);
    }
    float* getPOS() { queryPOS(); return X; }

    // Clamp |F_cmd| to F_max, send it, update X/V, then reset F_cmd to zero.
    bool render_F_cmd() {
        const float n = std::sqrt(F_cmd[0] * F_cmd[0] + F_cmd[1] * F_cmd[1] + F_cmd[2] * F_cmd[2]);
        float s = (n > F_max && n > 0.0f) ? F_max / n : 1.0f;
        if (!std::isfinite(n)) s = 0.0f;
        for (int i = 0; i < 3; i++) { F_sent[i] = F_cmd[i] * s; F_cmd[i] = 0.0f; }
        return exchange(F_sent);
    }

    // Raw joint angles (deg) and angular velocities (deg/s) with zero joint torque. Works before calibration.
    // Switches the device to joint mode; the next exchange() switches it back to cursor mode.
    bool queryJOINTS() {
        if (!serial_.is_open()) return false;
        uint8_t tx[13] = {CMD_JOINT_TORQUES};   // + three float 0.0f torques
        float rx[6];
        if (!serial_.write_all(tx, sizeof(tx)) || !read_reply(RSP_JOINT_STATES, rx, 6)) { resync(); return false; }
        for (int i = 0; i < 3; i++) { q[i] = rx[i]; qdot[i] = rx[3 + i]; }
        return true;
    }

    // ---- Start / stop, same names as myVIRTUOSE ------------------------------------------------

    void print_info() const {
        printf("Inverse3 '%s' on %s\n", name.c_str(), port.c_str());
        printf("  device id   : %u (0x%04X)\n", device_id, device_id);
        printf("  UUID        : %s\n", uuid.c_str());
        printf("  joints (deg): [% 8.3f % 8.3f % 8.3f]\n", q[0], q[1], q[2]);
    }

    static void print_calibration_help() {
        printf("\n  >>> The Inverse3 is NOT CALIBRATED, so it reports no cursor position (X = 0, V = 65535).\n"
               "  >>> Front LED purple = needs calibration. Rest the cursor on the magnetic dock until the LED\n"
               "  >>> changes colour, then lift it off. Calibrate after every power-up. Motor power is not needed.\n\n");
    }

    // Same role as debug_getPOS() in myVIRTUOSE: print 10 samples so you can see the data is sane.
    void debug_getPOS(int n = 10) {
        printf("Inverse3 debugging: %d samples\n", n);
        for (int i = 0; i < n; i++) {
            const bool ok = queryPOS();
            printf("  X = [% .5f % .5f % .5f] m   V = [% .4f % .4f % .4f] m/s   %s (%.0f us)\n",
                   X[0], X[1], X[2], V[0], V[1], V[2],
                   ok ? (calibrated ? "ok" : "ok, not calibrated") : last_error.c_str(), last_exchange_us);
        }
        if (!calibrated) print_calibration_help();
        else printf("Debugging done: positions should change when you move the cursor.\n");
    }

    bool quick_start() {
        printf("quick start entails - (i) find + open the port, (ii) wake up the device, (iii) read 10 samples.\n");
        if (!connect()) return false;
        queryJOINTS();      // raw encoders: shows the device is alive even before calibration
        print_info();
        debug_getPOS();
        return true;
    }

    // Always leave the device with zero force before closing.
    void quick_stop() {
        if (!serial_.is_open()) return;
        printf("quick stop entails - (i) zero force, (ii) close the port.\n");
        for (int i = 0; i < 3; i++) F_cmd[i] = 0.0f;
        queryPOS();
        disconnect();
    }

private:
    my::SerialPort serial_;

    bool wakeup() {
        serial_.flush_input();
        for (int attempt = 0; attempt < 3; attempt++) {
            const uint8_t cmd = CMD_WAKEUP;
            uint8_t rx[21];
            if (serial_.write_all(&cmd, 1) && read_reply_bytes(RSP_WAKEUP, rx, sizeof(rx), 200)) {
                device_id = (uint16_t)(rx[0] | (rx[1] << 8));
                std::memcpy(info_bytes, rx + 2, 3);
                char buf[40];
                const uint8_t* u = rx + 5;
                std::snprintf(buf, sizeof(buf), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                              u[0], u[1], u[2], u[3], u[4], u[5], u[6], u[7], u[8], u[9], u[10], u[11], u[12], u[13],
                              u[14], u[15]);
                uuid = buf;
                return true;
            }
            resync();
        }
        return false;
    }

    // Read a reply with header `expect` and `count` floats, skipping any status events before it.
    bool read_reply(uint8_t expect, float* out, int count) {
        uint8_t buf[64];
        if (!read_reply_bytes(expect, buf, (size_t)count * 4, timeout_ms)) return false;
        std::memcpy(out, buf, (size_t)count * 4);
        return true;
    }

    bool read_reply_bytes(uint8_t expect, uint8_t* out, size_t n, int tmo_ms) {
        for (int guard = 0; guard < 16; guard++) {
            uint8_t h = 0;
            if (serial_.read_exact(&h, 1, tmo_ms) != 1) { last_error = "timeout"; return false; }
            if (h == expect) {
                if (serial_.read_exact(out, n, tmo_ms) != n) { last_error = "short reply"; return false; }
                skip_trailing_events();
                return true;
            }
            if (h == EVT_STATUS) { if (!read_status_event(tmo_ms)) return false; continue; }
            char msg[48];
            std::snprintf(msg, sizeof(msg), "unexpected header 0x%02X", h);
            last_error = msg;
            return false;
        }
        last_error = "too many status events";
        return false;
    }

    // Status event: 0xBA, type, length, payload[length]
    bool read_status_event(int tmo_ms) {
        uint8_t hdr[2];
        if (serial_.read_exact(hdr, 2, tmo_ms) != 2) { last_error = "short status event"; return false; }
        uint8_t payload[255];
        if (hdr[1] && serial_.read_exact(payload, hdr[1], tmo_ms) != hdr[1]) { last_error = "short status event"; return false; }
        if (hdr[1] >= 2) { last_status[0] = payload[0]; last_status[1] = payload[1]; }
        n_status_events++;
        return true;
    }

    // Consume status events that are already waiting right after a reply (never blocks for long).
    void skip_trailing_events() {
        while (serial_.available() >= 3) {
            uint8_t h = 0;
            if (serial_.read_exact(&h, 1, 1) != 1) return;
            if (h != EVT_STATUS) { serial_.flush_input(); return; }   // should not happen: resync
            if (!read_status_event(timeout_ms)) return;
        }
    }

    // After an error: wait a moment for late bytes, then drop everything so the next reply starts clean.
    void resync() {
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
        serial_.flush_input();
    }
};
