// myUDP.h - minimal non-blocking UDP sockets for Windows and Linux/macOS.
// Successor of myVIRTUOSE_UDP.h: same idea (send to one address, receive on one port, never block),
// without the Windows-only parts.
//
// Any program on the same computer can send a datagram to a 127.0.0.1 port, so a receiver must never trust
// what arrives just because it arrived. The lab engine checks a secret token at the start of every datagram
// (see lab/engine/haply_lab_engine.cpp); this file only moves the bytes.
#pragma once

#include <cstdint>
#include <cstring>
#include <string>

#if defined(_WIN32)
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #pragma comment(lib, "ws2_32.lib")
  #ifndef SIO_UDP_CONNRESET
    #define SIO_UDP_CONNRESET _WSAIOW(IOC_VENDOR, 12)
  #endif
  using my_socket_t = SOCKET;
  static const my_socket_t MY_BAD_SOCKET = INVALID_SOCKET;
#else
  #include <arpa/inet.h>
  #include <fcntl.h>
  #include <netinet/in.h>
  #include <sys/socket.h>
  #include <unistd.h>
  using my_socket_t = int;
  static const my_socket_t MY_BAD_SOCKET = -1;
#endif

namespace my {

class UdpSocket {
public:
    UdpSocket() {
#if defined(_WIN32)
        WSADATA w;
        WSAStartup(MAKEWORD(2, 2), &w);
#endif
    }
    ~UdpSocket() {
        close();
#if defined(_WIN32)
        WSACleanup();
#endif
    }

    // Listen on 127.0.0.1:recv_port (0 = send only) and send to send_host:send_port.
    // Fails if another program already listens on recv_port (no SO_REUSEADDR: the port is ours alone).
    bool open(int recv_port, const std::string& send_host, int send_port) {
        s_ = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (s_ == MY_BAD_SOCKET) return false;
#if defined(_WIN32)
        u_long nb = 1;
        ioctlsocket(s_, FIONBIO, &nb);
        // Windows lets a second socket steal a bound port unless the first one asks for exclusive use.
        BOOL excl = TRUE;
        setsockopt(s_, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char*)&excl, sizeof(excl));
        // Windows reports "port unreachable" from an earlier send as an error on the next recvfrom(),
        // e.g. while the server is not listening yet. Turn that off: it would hide waiting commands.
        BOOL report = FALSE;
        DWORD bytes = 0;
        WSAIoctl(s_, SIO_UDP_CONNRESET, &report, sizeof(report), nullptr, 0, &bytes, nullptr, nullptr);
#else
        fcntl(s_, F_SETFL, fcntl(s_, F_GETFL, 0) | O_NONBLOCK);
#endif
        if (recv_port > 0) {
            sockaddr_in a{};
            a.sin_family = AF_INET;
            a.sin_port = htons((uint16_t)recv_port);
            inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
            if (::bind(s_, (sockaddr*)&a, sizeof(a)) != 0) { close(); return false; }
        }
        to_ = sockaddr_in{};
        to_.sin_family = AF_INET;
        to_.sin_port = htons((uint16_t)send_port);
        inet_pton(AF_INET, send_host.c_str(), &to_.sin_addr);
        return true;
    }

    void close() {
        if (s_ == MY_BAD_SOCKET) return;
#if defined(_WIN32)
        closesocket(s_);
#else
        ::close(s_);
#endif
        s_ = MY_BAD_SOCKET;
    }

    bool send(const std::string& msg) {
        if (s_ == MY_BAD_SOCKET) return false;
        return ::sendto(s_, msg.data(), (int)msg.size(), 0, (const sockaddr*)&to_, sizeof(to_)) == (int)msg.size();
    }

    // Takes one waiting datagram, never blocks. Returns false when nothing is waiting.
    // A datagram longer than max_len bytes is taken off the queue but not returned: recv() then returns true
    // with msg empty and *too_long set, so the caller can count it and move on.
    bool recv(std::string& msg, size_t max_len = 1024, bool* too_long = nullptr) {
        if (too_long) *too_long = false;
        if (s_ == MY_BAD_SOCKET) return false;
        char buf[4096];
        const int n = (int)::recvfrom(s_, buf, (int)sizeof(buf), 0, nullptr, nullptr);
        if (n < 0) {
#if defined(_WIN32)
            // Windows: the datagram did not fit in buf and the rest of it is gone
            if (WSAGetLastError() == WSAEMSGSIZE) { msg.clear(); if (too_long) *too_long = true; return true; }
#endif
            return false;                     // nothing waiting (or a socket error): try again next time
        }
        if ((size_t)n > max_len || (size_t)n >= sizeof(buf)) {   // (Linux cuts a longer datagram to sizeof(buf))
            msg.clear();
            if (too_long) *too_long = true;
            return true;
        }
        msg.assign(buf, (size_t)n);
        return true;
    }

private:
    my_socket_t s_ = MY_BAD_SOCKET;
    sockaddr_in to_{};
};

}  // namespace my
