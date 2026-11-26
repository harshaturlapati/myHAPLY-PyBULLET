#!/usr/bin/env python3
"""haply_term.py - the terminal behind the lab page's "Terminal" tab (Linux, Python 3.8+, standard library).

Runs as the restricted 'student' user (see lab/systemd/haply-term.service: no sudo, CAN sockets blocked) and
listens on 127.0.0.1 only. lab/haply_lab.py checks the lab key and relays the browser's WebSocket here.
Each connection gets its own login shell in a pseudo-terminal:

    browser (xterm.js)  --WebSocket-->  haply_lab.py  --TCP relay-->  haply_term.py  --pty-->  bash -l

Only the relay may connect: it adds the header "X-Haply-Relay: 1", and a WebSocket without it is refused.
A web page cannot add custom headers to a WebSocket, so a page shown by a browser on the Pi itself cannot
open ws://127.0.0.1:8781 and get a shell without the lab key.

Messages from the browser are JSON text frames: {"t":"i","d":"<keys>"} for input, {"t":"r","c":cols,"r":rows}
for a resize. The shell's output goes back as binary frames.

When a terminal closes, everything started from it is stopped too (background jobs, nohup, disown), and when
the last terminal closes, every remaining process of the 'student' user is killed: nothing a student started
keeps running (or keeps talking to the device) after they leave.
"""

import argparse
import base64
import fcntl
import hashlib
import json
import os
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
HANDSHAKE_TIMEOUT_S = 10      # the relay sends its request at once; anything slower is not the relay
MAX_MESSAGE = 1 << 20         # one WebSocket message, all its fragments together (a big paste fits easily)
KILL_GRACE_S = 1.0            # after SIGHUP, the shell gets this long to exit before SIGKILL
INPUT_STALL_S = 5.0           # input the shell does not read for this long is dropped
RESTRICTED_USER = "student"   # only as this user do we kill all of its processes when the last terminal closes

BANNER = (
    "\x1b[1mHaply lab terminal\x1b[0m - you are \x1b[1m{user}\x1b[0m on {host}.\r\n"
    "Your copy of the code: ~/myHAPLY-PyBULLET   (git pull to update it)\r\n"
    "  build:   cd ~/myHAPLY-PyBULLET && cmake -S . -B build && cmake --build build -j2\r\n"
    "  run:     ./build/100-Haply-basics_01_read_fbk     (first press 'Release device' on the page)\r\n"
    "You cannot use sudo or the robot arms' CAN links from here. Ctrl+D or 'exit' closes this shell;\r\n"
    "closing it (or the tab) also stops everything you started from it.\r\n\r\n"
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
    buf = bytearray()
    while len(buf) < n:
        chunk = conn.recv(min(n - len(buf), 65536))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return bytes(buf)


def unmask(data, mask):
    """Browser-to-server frames are XORed with a 4-byte mask. XOR as two big integers: fast even for 1 MiB."""
    n = len(data)
    if n == 0:
        return data
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


def recv_message(conn, out):
    """Return (opcode, payload) of the next complete message (fragments joined), or (8, ...) for a close.
    Pings are answered here and pongs ignored: control frames may come between the fragments of a message."""
    message, first_op = bytearray(), None
    while True:
        b1, b2 = recv_exact(conn, 2)
        fin, op = b1 & 0x80, b1 & 0x0F
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack(">H", recv_exact(conn, 2))[0]
        elif n == 127:
            n = struct.unpack(">Q", recv_exact(conn, 8))[0]
        if op >= 8 and n > 125:
            raise ConnectionError("control frame too large")
        if len(message) + n > MAX_MESSAGE:              # counts the fragments so far, not just this frame
            raise ConnectionError("message too large")
        mask = recv_exact(conn, 4) if b2 & 0x80 else b"\0\0\0\0"
        payload = unmask(recv_exact(conn, n), mask)
        if op == 8:
            return op, payload
        if op == 9:
            out.send(10, payload)
            continue
        if op >= 8:                                     # pong (10) or a reserved control opcode
            continue
        if first_op is None:
            if op == 0:
                raise ConnectionError("continuation frame without a first frame")
            first_op = op
        elif op != 0:
            raise ConnectionError("new message inside a fragmented one")
        message += payload
        if fin:
            return first_op, bytes(message)


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
    rows, cols = min(max(2, rows), 1000), min(max(2, cols), 1000)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data, stop):
    """Type data into the shell. The pty's input buffer is only ~4 kB: if the program in it is not reading,
    wait a little, then drop the rest (like keys typed into a frozen program) instead of blocking for ever,
    which would also stop us noticing that the browser has gone."""
    give_up = time.monotonic() + INPUT_STALL_S
    while data and not stop.is_set() and time.monotonic() < give_up:
        try:
            data = data[os.write(fd, data):]
        except BlockingIOError:
            select.select([], [fd], [], 0.2)


# ---------------------------------------------------------------- stopping what a terminal started
def session_members(sid):
    """pids of all processes in session sid. The shell is a session leader (forkpty calls setsid), so sid is
    the shell's pid, and every job started from it stays in that session, including '&', nohup and disown.
    (Only a program that calls setsid itself leaves it: see kill_leftovers.)"""
    out = []
    try:
        names = os.listdir("/proc")
    except OSError:
        return out
    for name in names:
        if not name.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % name, "rb") as f:
                stat = f.read()
            # "pid (comm) state ppid pgrp session ..."; comm may contain spaces and ')', so split after the last ')'
            fields = stat[stat.rindex(b")") + 2:].split()
            if int(fields[3]) == sid:
                out.append(int(name))
        except (OSError, ValueError, IndexError):
            continue
    return out


def signal_session(sid, sig):
    try:
        os.killpg(sid, sig)                     # the shell's own process group
    except OSError:
        pass
    for pid in session_members(sid):            # and every other job of that session
        try:
            os.kill(pid, sig)
        except OSError:
            pass


def end_shell(pid):
    """SIGHUP to the shell and its jobs (what closing a real terminal does), SIGKILL to whatever is left after
    KILL_GRACE_S (a shell with 'trap "" HUP', a nohup'ed program), and reap the shell so no zombie is left.
    The session id stays reserved while any member is alive, so it cannot be reused by somebody else's shell."""
    signal_session(pid, signal.SIGHUP)
    reaped = False
    deadline = time.monotonic() + KILL_GRACE_S
    while time.monotonic() < deadline:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            done = pid
        if done:
            reaped = True
            break
        time.sleep(0.05)
    signal_session(pid, signal.SIGKILL)
    if not reaped:
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass


def kill_leftovers():
    """No terminal is open any more: kill every other process of this user, including anything that escaped
    its session with setsid. kill(-1) signals every process we may signal except ourselves; as the
    unprivileged 'student' that is exactly the student's own processes. Never do this as another user."""
    me = pwd.getpwuid(os.getuid()).pw_name
    if os.getuid() == 0 or me != RESTRICTED_USER:
        return
    try:
        os.kill(-1, signal.SIGKILL)
    except OSError:                             # ESRCH: there was nothing left to kill
        pass


# ---------------------------------------------------------------- one terminal
def session(conn):
    global sessions
    conn.settimeout(HANDSHAKE_TIMEOUT_S)
    headers = read_http_head(conn)
    if not headers or headers.get("upgrade", "").lower() != "websocket" or "sec-websocket-key" not in headers:
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
        return
    if headers.get("x-haply-relay") != "1":     # not through haply_lab.py (which checked the lab key)
        conn.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
        return
    accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + GUID).encode()).digest()).decode()
    conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
    conn.settimeout(None)
    out = Sender(conn)

    with sessions_lock:
        if sessions >= MAX_SESSIONS:
            out.send(2, b"\r\nToo many terminals are open right now; try again in a minute.\r\n")
            out.send(8, b"")
            return
        sessions += 1

    # From here on, one try/finally covers everything, so the slot, the pty and the shell are always given
    # back, whatever fails (no shell could be started, the browser left during the banner, ...).
    pid, fd, reader = None, None, None
    stop = threading.Event()
    try:
        me = pwd.getpwuid(os.getuid())
        try:
            pid, fd = os.forkpty()              # (unlike pty.fork, leaks nothing if the fork fails)
        except OSError as e:
            out.send(2, ("\r\nCannot start a shell right now (%s); try again in a minute.\r\n" % e.strerror).encode())
            out.send(8, b"")
            return
        if pid == 0:                            # child: a login shell in the user's home
            try:
                os.chdir(me.pw_dir)
                env = {"HOME": me.pw_dir, "USER": me.pw_name, "LOGNAME": me.pw_name, "SHELL": "/bin/bash",
                       "TERM": "xterm-256color", "LANG": "C.UTF-8", "PATH": "/usr/local/bin:/usr/bin:/bin"}
                os.execve("/bin/bash", ["bash", "-l"], env)
            except BaseException as e:
                os.write(2, ("cannot start bash: %s\r\n" % e).encode("utf-8", "replace"))
            finally:
                os._exit(127)                   # never return into the server's code in the child

        os.set_blocking(fd, False)              # see write_all
        set_size(fd, 100, 30)
        out.send(2, BANNER.format(user=me.pw_name, host=socket.gethostname()).encode())
        last = [time.monotonic()]

        def pty_to_ws():
            try:
                while not stop.is_set():
                    r, _, _ = select.select([fd], [], [], 1.0)
                    if fd in r:
                        try:
                            data = os.read(fd, 65536)
                        except BlockingIOError:
                            continue
                        if not data:
                            break
                        out.send(2, data)
                    elif time.monotonic() - last[0] > IDLE_TIMEOUT_S:
                        out.send(2, b"\r\n[closed after an hour without typing]\r\n")
                        break
            except OSError:                     # the shell exited (EIO), or the browser went away
                pass
            stop.set()
            try:
                out.send(8, b"")
            except OSError:
                pass
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        reader = threading.Thread(target=pty_to_ws, daemon=True)
        reader.start()
        while not stop.is_set():
            op, payload = recv_message(conn, out)
            if op == 8:
                break
            if op not in (1, 2):
                continue
            last[0] = time.monotonic()
            try:
                msg = json.loads(payload.decode("utf-8", "replace"))
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("t") == "i":
                write_all(fd, str(msg.get("d", "")).encode("utf-8", "replace"), stop)
            elif msg.get("t") == "r":
                try:
                    set_size(fd, int(msg.get("c", 100)), int(msg.get("r", 30)))
                except (TypeError, ValueError):
                    pass
    except (ConnectionError, OSError):
        pass
    finally:
        stop.set()
        try:
            conn.shutdown(socket.SHUT_RDWR)     # also makes the reader's send fail at once
        except OSError:
            pass
        if pid:
            end_shell(pid)
        if reader is not None:
            reader.join(timeout=3)
        # Close the pty only once the reader has stopped: a closed fd number is reused by the next terminal,
        # and a reader still running would then read (and send away) another student's terminal.
        if fd is not None and (reader is None or not reader.is_alive()):
            try:
                os.close(fd)
            except OSError:
                pass
        elif fd is not None:
            print("haply_term: terminal reader did not stop; leaving its pty open", flush=True)
        with sessions_lock:
            sessions -= 1
            if sessions == 0:
                kill_leftovers()                # under the lock: no new shell can start meanwhile


def run_session(conn):
    try:
        session(conn)
    except OSError:                             # the client went away (or timed out) during the handshake
        pass
    except Exception as e:
        print("haply_term: session error: %r" % (e,), flush=True)
    finally:
        conn.close()


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
        try:
            conn, _ = srv.accept()
        except OSError as e:                    # e.g. out of file descriptors: wait, do not crash
            print("haply_term: accept failed: %s" % e, flush=True)
            time.sleep(0.5)
            continue
        try:
            threading.Thread(target=run_session, args=(conn,), daemon=True).start()
        except RuntimeError:                    # no thread could be started (TasksMax reached)
            conn.close()


if __name__ == "__main__":
    if os.name != "posix":
        sys.exit("haply_term.py runs on Linux (the lab Pi) only")
    main()
