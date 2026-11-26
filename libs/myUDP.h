// myUDP.h - minimal non-blocking UDP sockets for Windows and Linux/macOS.
// Successor of myVIRTUOSE_UDP.h: same idea (send to one address, receive on one port, never block),
// without the Windows-only parts.
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
    bool open(int recv_port, const std::string& send_host, int send_port) {
        s_ = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (s_ == MY_BAD_SOCKET) return false;
#if defined(_WIN32)
        u_long nb = 1;
        ioctlsocket(s_, FIONBIO, &nb);
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

    // Returns true and fills msg if a datagram was waiting; never blocks.
    bool recv(std::string& msg) {
        if (s_ == MY_BAD_SOCKET) return false;
        char buf[4096];
        const int n = (int)::recvfrom(s_, buf, sizeof(buf) - 1, 0, nullptr, nullptr);
        if (n <= 0) return false;
        msg.assign(buf, (size_t)n);
        return true;
    }

private:
    my_socket_t s_ = MY_BAD_SOCKET;
    sockaddr_in to_{};
};

}  // namespace my
