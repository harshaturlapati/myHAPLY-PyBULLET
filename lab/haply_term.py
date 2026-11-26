#!/usr/bin/env python3
"""haply_term.py - the terminal behind the lab page's "Terminal" tab (Linux, Python 3.8+, standard library).

Runs as the restricted 'student' user (see lab/systemd/haply-term.service: no sudo, CAN sockets blocked) and
listens on 127.0.0.1 only. lab/haply_lab.py checks the lab key and relays the browser's WebSocket here.
Each connection gets its own login shell in a pseudo-terminal:

    browser (xterm.js)  --WebSocket-->  haply_lab.py  --TCP relay-->  haply_term.py  --pty-->  bash -l

Messages from the browser are JSON text frames: {"t":"i","d":"<keys>"} for input, {"t":"r","c":cols,"r":rows}
for a resize. The shell's output goes back as binary frames.
"""

import argparse
import base64
import fcntl
import hashlib
import json
import os
import pty
import pwd
import select
import signal
import socket
import struct
import sys
import termios
import threading
import time

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_SESSIONS = 6
IDLE_TIMEOUT_S = 3600

BANNER = (
    "\x1b[1mHaply lab terminal\x1b[0m - you are \x1b[1m{user}\x1b[0m on {host}.\r\n"
    "Your copy of the code: ~/myHAPLY-PyBULLET   (git pull to update it)\r\n"
    "  build:   cd ~/myHAPLY-PyBULLET && cmake -S . -B build && cmake --build build -j3\r\n"
    "  run:     ./build/100-Haply-basics_01_read_fbk     (first press 'Release device' on the page)\r\n"
    "You cannot use sudo or the robot arms' CAN links from here. Ctrl+D or 'exit' closes this shell.\r\n\r\n"
)

sessions = 0
sessions_lock = threading.Lock()


def read_http_head(conn):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(4096)
        if not chunk or len(data) > 16384:
            return None
        data += chunk
    head = data.split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")
    headers = {}
    for line in head[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return headers


def recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def recv_frame(conn):
    """Return (opcode, payload) of one complete message (fragments joined)."""
    message, first_op = b"", None
    while True:
        b1, b2 = recv_exact(conn, 2)
        fin, op = b1 & 0x80, b1 & 0x0F
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack(">H", recv_exact(conn, 2))[0]
        elif n == 127:
            n = struct.unpack(">Q", recv_exact(conn, 8))[0]
        if n > 1 << 20:
            raise ConnectionError("frame too large")
        mask = recv_exact(conn, 4) if b2 & 0x80 else b"\0\0\0\0"
        payload = bytes(c ^ mask[i % 4] for i, c in enumerate(recv_exact(conn, n)))
        if op >= 8:                      # control frames are never fragmented
            return op, payload
        if first_op is None:
            first_op = op
        message += payload
        if fin:
            return first_op, message


class Sender:
    def __init__(self, conn):
        self.conn, self.lock = conn, threading.Lock()

    def send(self, op, payload):
        n = len(payload)
        head = bytes([0x80 | op])
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack(">H", n)
        else:
            head += bytes([127]) + struct.pack(">Q", n)
        with self.lock:
            self.conn.sendall(head + payload)


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(2, rows), max(2, cols), 0, 0))


def session(conn, addr):
    global sessions
    headers = read_http_head(conn)
    if not headers or headers.get("upgrade", "").lower() != "websocket" or "sec-websocket-key" not in headers:
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
        return
    accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + GUID).encode()).digest()).decode()
    conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
    out = Sender(conn)

    with sessions_lock:
        if sessions >= MAX_SESSIONS:
            out.send(2, b"\r\nToo many terminals are open right now; try again in a minute.\r\n")
            out.send(8, b"")
            return
        sessions += 1

    me = pwd.getpwuid(os.getuid())
    pid, fd = pty.fork()
    if pid == 0:                                  # child: a login shell in the user's home
        os.chdir(me.pw_dir)
        env = {"HOME": me.pw_dir, "USER": me.pw_name, "LOGNAME": me.pw_name, "SHELL": "/bin/bash",
               "TERM": "xterm-256color", "LANG": "C.UTF-8", "PATH": "/usr/local/bin:/usr/bin:/bin"}
        os.execve("/bin/bash", ["bash", "-l"], env)

    set_size(fd, 100, 30)
    out.send(2, BANNER.format(user=me.pw_name, host=socket.gethostname()).encode())
    last = [time.time()]
    stop = threading.Event()

    def pty_to_ws():
        try:
            while not stop.is_set():
                r, _, _ = select.select([fd], [], [], 1.0)
                if fd in r:
                    data = os.read(fd, 65536)
                    if not data:
                        break
                    out.send(2, data)
                elif time.time() - last[0] > IDLE_TIMEOUT_S:
                    out.send(2, b"\r\n[closed after an hour without typing]\r\n")
                    break
        except OSError:
            pass
        stop.set()
        try:
            out.send(8, b"")
            conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    t = threading.Thread(target=pty_to_ws, daemon=True)
    t.start()
    try:
        while not stop.is_set():
            op, payload = recv_frame(conn)
            if op == 8:
                break
            if op == 9:
                out.send(10, payload)
                continue
            if op not in (1, 2):
                continue
            last[0] = time.time()
            try:
                msg = json.loads(payload.decode("utf-8", "replace"))
            except ValueError:
                continue
            if msg.get("t") == "i":
                os.write(fd, str(msg.get("d", "")).encode("utf-8"))
            elif msg.get("t") == "r":
                set_size(fd, int(msg.get("c", 100)), int(msg.get("r", 30)))
    except (ConnectionError, OSError):
        pass
    finally:
        stop.set()
        try:
            os.killpg(os.getpgid(pid), signal.SIGHUP)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
        os.close(fd)
        with sessions_lock:
            sessions -= 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8781)
    args = ap.parse_args()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", args.port))
    srv.listen(8)
    print("haply_term: terminals for user %s on 127.0.0.1:%d" % (pwd.getpwuid(os.getuid()).pw_name, args.port), flush=True)
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=lambda c=conn, a=addr: (session(c, a), c.close()), daemon=True).start()


if __name__ == "__main__":
    if os.name != "posix":
        sys.exit("haply_term.py runs on Linux (the lab Pi) only")
    main()
