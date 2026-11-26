// mySERIAL.h - small serial port for Windows (COMn) and Linux/macOS (/dev/ttyACMn, /dev/haply).
// The Haply Inverse3 is a USB CDC-ACM device (Teensy, USB id 16c0:0483): the baud rate is nominal; what
// matters is raw 8-bit mode, no flow control, and reads that return as soon as data arrives.
//
// Two rules that keep a force-feedback device safe:
//   * ONE program at a time. Two programs writing force commands to the same port would take turns
//     driving the arm, and each would read the other's replies. Windows refuses a second open by itself;
//     on Linux/macOS open() takes an exclusive lock (flock + TIOCEXCL), so a second program gets
//     "port in use by another program" instead of the device.
//   * NO call waits forever. Reads and writes give up after a timeout and report an error, so a stalled
//     device can never freeze the program that is supposed to switch its force off.
#pragma once

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#if defined(_WIN32)
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #include <windows.h>
  #include <setupapi.h>
  #include <devguid.h>
  #pragma comment(lib, "setupapi.lib")
  #pragma comment(lib, "advapi32.lib")
#else
  #include <dirent.h>
  #include <errno.h>
  #include <fcntl.h>
  #include <poll.h>
  #include <sys/file.h>
  #include <sys/ioctl.h>
  #include <sys/stat.h>
  #include <termios.h>
  #include <unistd.h>
  #include <cctype>
  #include <fstream>
#endif

namespace my {

class SerialPort {
public:
    SerialPort() = default;
    ~SerialPort() { close(); }
    SerialPort(const SerialPort&) = delete;
    SerialPort& operator=(const SerialPort&) = delete;

    // Longest time write_all() may wait for the device to take the bytes (a healthy write takes microseconds).
    static constexpr int WRITE_TIMEOUT_MS = 100;

    // port: "COM5" on Windows; "/dev/haply", "/dev/ttyACM0" or "/dev/cu.usbmodemXXXX" elsewhere.
    bool open(const std::string& port) {
        close();
        port_ = port;
#if defined(_WIN32)
        std::string path = port;
        if (path.rfind("\\\\.\\", 0) != 0) path = "\\\\.\\" + path;   // required for COM10 and above
        // share mode 0 = exclusive: while we hold the port, every other open() fails with "access denied"
        h_ = CreateFileA(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (h_ == INVALID_HANDLE_VALUE) { set_error("open"); return false; }
        DCB dcb{};
        dcb.DCBlength = sizeof(dcb);
        if (!GetCommState(h_, &dcb)) { set_error("GetCommState"); close(); return false; }
        dcb.BaudRate = CBR_115200;
        dcb.ByteSize = 8;
        dcb.Parity = NOPARITY;
        dcb.StopBits = ONESTOPBIT;
        dcb.fBinary = TRUE;
        dcb.fParity = FALSE;
        dcb.fOutxCtsFlow = FALSE;
        dcb.fOutxDsrFlow = FALSE;
        dcb.fDsrSensitivity = FALSE;
        dcb.fDtrControl = DTR_CONTROL_ENABLE;
        dcb.fRtsControl = RTS_CONTROL_ENABLE;
        dcb.fOutX = FALSE;
        dcb.fInX = FALSE;
        dcb.fNull = FALSE;
        dcb.fAbortOnError = FALSE;
        if (!SetCommState(h_, &dcb)) { set_error("SetCommState"); close(); return false; }
        // ReadFile returns as soon as at least one byte is there, or after the timeout (set per call).
        COMMTIMEOUTS t{};
        t.ReadIntervalTimeout = MAXDWORD;
        t.ReadTotalTimeoutMultiplier = MAXDWORD;
        t.ReadTotalTimeoutConstant = 20;
        t.WriteTotalTimeoutConstant = WRITE_TIMEOUT_MS;
        SetCommTimeouts(h_, &t);
        current_timeout_ms_ = 20;
        PurgeComm(h_, PURGE_RXCLEAR | PURGE_TXCLEAR);
        return true;
#else
        // O_NONBLOCK: read() and write() never sleep; read_exact() and write_all() wait with poll() and a deadline.
        fd_ = ::open(port.c_str(), O_RDWR | O_NOCTTY | O_CLOEXEC | O_NONBLOCK);
        if (fd_ < 0) {
            const bool busy = errno == EBUSY;   // another program holds it with TIOCEXCL
            set_error("open");
            if (busy) error_ += " (port in use by another program; in the lab: press 'Release device' first)";
            return false;
        }
        // Linux happily opens a tty twice, so ask for it alone. flock() fails if another program that uses this
        // class holds the port; TIOCEXCL then makes every later open() by a normal user fail with EBUSY.
        if (flock(fd_, LOCK_EX | LOCK_NB) != 0) {
            error_ = "port " + port + " is in use by another program (in the lab: press 'Release device' first)";
            ::close(fd_);
            fd_ = -1;
            return false;
        }
        if (ioctl(fd_, TIOCEXCL) != 0) { set_error("TIOCEXCL"); close(); return false; }
        termios tio{};
        if (tcgetattr(fd_, &tio) != 0) { set_error("tcgetattr"); close(); return false; }
        cfmakeraw(&tio);
        tio.c_cflag |= (CLOCAL | CREAD);
        tio.c_cflag &= ~CRTSCTS;
        tio.c_cc[VMIN] = 0;
        tio.c_cc[VTIME] = 0;
        cfsetispeed(&tio, B115200);
        cfsetospeed(&tio, B115200);
        if (tcsetattr(fd_, TCSANOW, &tio) != 0) { set_error("tcsetattr"); close(); return false; }
        tcflush(fd_, TCIOFLUSH);
        return true;
#endif
    }

    bool is_open() const {
#if defined(_WIN32)
        return h_ != INVALID_HANDLE_VALUE;
#else
        return fd_ >= 0;
#endif
    }

    void close() {
#if defined(_WIN32)
        if (h_ != INVALID_HANDLE_VALUE) { CloseHandle(h_); h_ = INVALID_HANDLE_VALUE; }
#else
        if (fd_ >= 0) {
            ioctl(fd_, TIOCNXCL);   // give up the exclusive use; the flock goes away with close()
            ::close(fd_);
            fd_ = -1;
        }
#endif
    }

    // Write all n bytes, or give up after WRITE_TIMEOUT_MS (a device that stopped taking data).
    bool write_all(const uint8_t* data, size_t n) {
#if defined(_WIN32)
        DWORD written = 0;
        if (!WriteFile(h_, data, (DWORD)n, &written, nullptr)) { set_error("write"); return false; }
        if (written != n) { error_ = "write timeout"; return false; }   // WriteTotalTimeoutConstant expired
        return true;
#else
        size_t done = 0;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(WRITE_TIMEOUT_MS);
        while (done < n) {
            const ssize_t w = ::write(fd_, data + done, n - done);
            if (w > 0) { done += (size_t)w; continue; }
            if (w < 0 && errno == EINTR) continue;
            if (w < 0 && errno != EAGAIN && errno != EWOULDBLOCK) { set_error("write"); return false; }
            // the output buffer is full: wait until the device takes more bytes, but not forever
            const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  deadline - std::chrono::steady_clock::now()).count();
            if (left <= 0) { error_ = "write timeout"; return false; }
            pollfd p{fd_, POLLOUT, 0};
            const int pr = ::poll(&p, 1, (int)left);
            if (pr == 0) { error_ = "write timeout"; return false; }
            if (pr < 0) { if (errno == EINTR) continue; set_error("poll"); return false; }
            if (p.revents & (POLLERR | POLLHUP | POLLNVAL)) { error_ = "device disconnected"; return false; }
        }
        return true;
#endif
    }

    // Read exactly n bytes, or stop when timeout_ms has passed. Returns the number of bytes read.
    size_t read_exact(uint8_t* data, size_t n, int timeout_ms) {
        size_t got = 0;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
        while (got < n) {
            const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  deadline - std::chrono::steady_clock::now()).count();
            if (left < 0) { error_ = "timeout"; break; }
#if defined(_WIN32)
            // Each ReadFile returns at once if bytes are waiting, otherwise waits up to timeout_ms for one.
            if ((DWORD)timeout_ms != current_timeout_ms_) {
                COMMTIMEOUTS t{};
                t.ReadIntervalTimeout = MAXDWORD;
                t.ReadTotalTimeoutMultiplier = MAXDWORD;
                t.ReadTotalTimeoutConstant = (DWORD)(timeout_ms < 1 ? 1 : timeout_ms);
                t.WriteTotalTimeoutConstant = 100;
                SetCommTimeouts(h_, &t);
                current_timeout_ms_ = (DWORD)timeout_ms;
            }
            DWORD r = 0;
            if (!ReadFile(h_, data + got, (DWORD)(n - got), &r, nullptr)) { set_error("read"); break; }
            got += r;
#else
            pollfd p{fd_, POLLIN, 0};
            const int pr = ::poll(&p, 1, (int)left);
            if (pr == 0) { error_ = "timeout"; break; }
            if (pr < 0) { if (errno == EINTR) continue; set_error("poll"); break; }
            if (p.revents & (POLLERR | POLLHUP | POLLNVAL)) { error_ = "device disconnected"; break; }
            const ssize_t r = ::read(fd_, data + got, n - got);
            if (r < 0) { if (errno == EINTR || errno == EAGAIN) continue; set_error("read"); break; }
            if (r == 0) { error_ = "device disconnected"; break; }
            got += (size_t)r;
#endif
        }
        return got;
    }

    // Bytes waiting in the receive buffer (never blocks).
    int available() {
#if defined(_WIN32)
        COMSTAT st{};
        DWORD errs = 0;
        if (!ClearCommError(h_, &errs, &st)) return 0;
        return (int)st.cbInQue;
#else
        int n = 0;
        if (ioctl(fd_, FIONREAD, &n) != 0) return 0;
        return n;
#endif
    }

    // Drop everything waiting in the receive buffer.
    void flush_input() {
#if defined(_WIN32)
        PurgeComm(h_, PURGE_RXCLEAR);
#else
        tcflush(fd_, TCIFLUSH);
#endif
    }

    const std::string& port() const { return port_; }
    const std::string& last_error() const { return error_; }

private:
    void set_error(const char* what) {
#if defined(_WIN32)
        const DWORD e = GetLastError();
        error_ = std::string(what) + " failed (Windows error " + std::to_string(e) + ")";
        if (e == ERROR_ACCESS_DENIED) error_ += ": port in use by another program";
        if (e == ERROR_FILE_NOT_FOUND) error_ += ": no such port";
#else
        error_ = std::string(what) + " failed: " + std::strerror(errno);
#endif
    }

    std::string port_, error_;
#if defined(_WIN32)
    HANDLE h_ = INVALID_HANDLE_VALUE;
    DWORD current_timeout_ms_ = 0;
#else
    int fd_ = -1;
#endif
};

// ---------------------------------------------------------------------------------------------
// Find serial ports by USB vendor/product id (the Inverse3 is a Teensy: 16c0:0483).
// Linux puts /dev/haply first if the lab udev rule created it.
// ---------------------------------------------------------------------------------------------
inline std::vector<std::string> find_usb_serial_ports(uint16_t vid, uint16_t pid) {
    std::vector<std::string> ports;
#if defined(_WIN32)
    char want[32];
    std::snprintf(want, sizeof(want), "VID_%04X&PID_%04X", vid, pid);
    HDEVINFO set = SetupDiGetClassDevsA(&GUID_DEVCLASS_PORTS, nullptr, nullptr, DIGCF_PRESENT);
    if (set == INVALID_HANDLE_VALUE) return ports;
    SP_DEVINFO_DATA info{};
    info.cbSize = sizeof(info);
    for (DWORD i = 0; SetupDiEnumDeviceInfo(set, i, &info); ++i) {
        char id[512] = {0};
        if (!SetupDiGetDeviceInstanceIdA(set, &info, id, sizeof(id), nullptr)) continue;
        std::string sid(id);
        for (auto& c : sid) c = (char)toupper((unsigned char)c);
        if (sid.find(want) == std::string::npos) continue;
        HKEY key = SetupDiOpenDevRegKey(set, &info, DICS_FLAG_GLOBAL, 0, DIREG_DEV, KEY_READ);
        if (key == INVALID_HANDLE_VALUE) continue;
        char name[64] = {0};
        DWORD len = sizeof(name), type = 0;
        if (RegQueryValueExA(key, "PortName", nullptr, &type, (LPBYTE)name, &len) == ERROR_SUCCESS) ports.emplace_back(name);
        RegCloseKey(key);
    }
    SetupDiDestroyDeviceInfoList(set);
#elif defined(__linux__)
    struct stat st{};
    std::string haply_target;
    if (stat("/dev/haply", &st) == 0) {
        ports.emplace_back("/dev/haply");
        char buf[256] = {0};
        ssize_t l = readlink("/dev/haply", buf, sizeof(buf) - 1);
        if (l > 0) haply_target = std::string("/dev/") + buf;
    }
    auto read_hex = [](const std::string& path) -> long {
        std::ifstream f(path);
        std::string s;
        if (!(f >> s)) return -1;
        return std::strtol(s.c_str(), nullptr, 16);
    };
    if (DIR* d = opendir("/sys/class/tty")) {
        while (dirent* e = readdir(d)) {
            std::string n = e->d_name;
            if (n.rfind("ttyACM", 0) != 0 && n.rfind("ttyUSB", 0) != 0) continue;
            const std::string base = "/sys/class/tty/" + n + "/device/../";   // USB device of this interface
            if (read_hex(base + "idVendor") == vid && read_hex(base + "idProduct") == pid) {
                const std::string dev = "/dev/" + n;
                if (dev != haply_target) ports.push_back(dev);
            }
        }
        closedir(d);
    }
#else   // macOS: no VID/PID lookup without IOKit; list the usual CDC-ACM names
    if (DIR* d = opendir("/dev")) {
        while (dirent* e = readdir(d)) {
            std::string n = e->d_name;
            if (n.rfind("cu.usbmodem", 0) == 0) ports.push_back("/dev/" + n);
        }
        closedir(d);
    }
    (void)vid; (void)pid;
#endif
    return ports;
}

}  // namespace my
