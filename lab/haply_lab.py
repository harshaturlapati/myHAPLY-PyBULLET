#!/usr/bin/env python3
"""haply_lab.py - the web half of the Haply lab console (Python 3.8+, standard library only).

It is NOT in the haptic loop. The C++ engine (build/haply_lab_engine) owns the Haply and runs the 1 kHz
loop; this server only
  * starts the engine, watches that it is still alive and talking, and relays its ~100 Hz state to browsers
    (Server-Sent Events, ~30 Hz per page),
  * passes the controlling student's commands to the engine (UDP on 127.0.0.1),
  * keeps one student in control at a time, and sends the engine a heartbeat only while that student's
    page is alive (if the page dies, the engine's watchdog switches forces off within 2 s),
  * lists and serves recordings, serves source files read-only for the code explorer, stores feedback,
  * relays the in-page terminal to lab/haply_term.py (which runs as the restricted 'student' user),
  * serves the web app itself (the repository's docs/ folder, the same files as GitHub Pages).

Every /api/ call needs a key (?key=... in the link, or the X-Lab-Key header). There are two:
  * the lab key  (~/.config/haply-lab/key): take control, drive the device, record, terminal, feedback...
  * the view key (~/.config/haply-lab/viewkey): watch only (state, stream, code explorer, list of recordings)
    plus the stop button. The lab TV uses it, so a link copied off the TV cannot drive the device.

The UDP link to the engine is authenticated. Any program on this computer (the student terminal too) can
send a datagram to 127.0.0.1, so for every engine it starts the server makes a fresh secret token and hands
it over in the environment variable HAPLY_LAB_TOKEN (not on the command line, which every user can read
with ps). Every datagram in both directions starts with "<token> "; anything else is dropped.

    python3 lab/haply_lab.py                       # real device
    python3 lab/haply_lab.py --sim                 # simulator, no device needed
"""

import argparse
import datetime
import glob
import hmac
import json
import mimetypes
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WEB_ROOT = os.path.join(REPO, "docs")
GITHUB = "https://github.com/harshaturlapati/myHAPLY-PyBULLET"

# Files the code explorer may show (relative to the repository root)
SOURCE_GLOBS = ["libs/*.h", "libs/compat/*.cpp", "lab/*.py", "lab/engine/*.cpp", "lab/*.md",
                "[0-9]*-*/*.cpp", "CMakeLists.txt", "cmake/*.cmake", "docs/learn/*.md", "docs/app.js",
                "README.md", "CONTRIBUTING.md"]
SOURCE_EXT = (".h", ".hpp", ".cpp", ".py", ".md", ".txt", ".cmake", ".js")

# All the timers below use time.monotonic(): the Pi has no clock battery, so the wall clock can jump by
# hours when it syncs over the network, and a lease measured with time.time() would expire (or never expire).
CONTROL_LEASE_S = 3.0      # controller must ping at least this often or loses control
HB_PERIOD_S = 0.2          # heartbeat to the engine while the controller is alive
HB_ALIVE_S = 0.8           # controller ping younger than this -> heartbeat is sent (pages ping every 0.4 s)
ENGINE_START_S = 5.0       # a new engine must send its first state within this time...
ENGINE_STALE_S = 3.0       # ...and then never go quiet for longer, or it is stuck: stop it and start a new one
ENGINE_QUIT_S = 3.0        # when asked to quit (shutdown, 'Restart engine'), the engine gets this long...
ENGINE_SAVE_S = 20.0       # ...or up to this long while it keeps reporting (forces already off) and saves a recording

HTTP_TIMEOUT_S = 30        # a client that sends nothing (or stops reading) is dropped after this long
SSE_WRITE_TIMEOUT_S = 10   # a live stream whose browser stopped reading (laptop asleep) is dropped
MAX_BODY = 200000          # largest POST body we read (a recording's notes are at most 20000 characters)
MAX_CONN_PER_IP = 64       # open connections per address (one page needs 2-3), so one laptop cannot use them all
MAX_VIEWERS = 500

CLIENT_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")      # the page uses 10 random base-36 characters
FLOAT = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
CMD_PATTERNS = [re.compile(p, re.ASCII) for p in (   # re.ASCII: \d is 0-9 only, not every digit in Unicode
    r"forces [01]",
    r"set kind (free|impedance|wall|custom)",
    r"set (xd|rpy|k|b) %s %s %s" % (FLOAT, FLOAT, FLOAT),
    r"set fmax %s" % FLOAT,
    r"expr (fx|fy|fz) [ -~]{0,240}",
    r"rec (start [A-Za-z0-9 _-]{0,60}|stop)",
    r"sim %s %s %s" % (FLOAT, FLOAT, FLOAT),
)]
MAX_CMDS = 20

# What the read-only view key may do. Everything else needs the lab key.
VIEW_GET = {"/api/hello", "/api/state", "/api/stream", "/api/files", "/api/source", "/api/recordings"}
VIEW_POST = {"/api/stop", "/api/ping"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def client_id(v):
    """The page's random client id, or "" if it is missing or malformed (an empty id would be shared)."""
    return v if isinstance(v, str) and CLIENT_RE.fullmatch(v) else ""


def keepalive(sock):
    """Let TCP notice a laptop that vanished (Wi-Fi off, lid closed) within about two minutes, not hours."""
    opts = [(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)]
    for name, value in (("TCP_KEEPIDLE", 60), ("TCP_KEEPINTVL", 15), ("TCP_KEEPCNT", 4),
                        ("TCP_USER_TIMEOUT", 120000)):          # Linux: unacknowledged data for 2 min -> give up
        if hasattr(socket, name):
            opts.append((socket.IPPROTO_TCP, getattr(socket, name), value))
    for level, opt, value in opts:
        try:
            sock.setsockopt(level, opt, value)
        except OSError:
            pass


class BadRequest(Exception):
    """Raised inside a request handler to answer with a JSON error instead of a result."""

    def __init__(self, code, msg):
        Exception.__init__(self, msg)
        self.code, self.msg = code, msg


class Lab:
    """Shared state between the HTTP threads, the UDP receiver and the engine manager."""

    def __init__(self, args):
        self.args = args
        self.key = self._load_key(args.key_file)
        view_file = args.view_key_file or os.path.join(os.path.dirname(os.path.expanduser(args.key_file)), "viewkey")
        self.view_key = self._load_key(view_file)
        if self.view_key == self.key:
            log("WARNING: the view key equals the lab key, so the TV link can drive the device: delete", view_file)
        self.key_b = self.key.encode("utf-8")
        self.view_key_b = self.view_key.encode("utf-8")
        self.data_dir = os.path.abspath(os.path.expanduser(args.data))
        self.feedback_file = os.path.join(os.path.abspath(os.path.expanduser(args.feedback)), "feedback.jsonl")
        os.makedirs(self.data_dir, exist_ok=True)
        os.makedirs(os.path.dirname(self.feedback_file), exist_ok=True)

        self.lock = threading.Lock()                 # control, viewers and state; never held during file I/O
        self.changed = threading.Condition(self.lock)
        self.feedback_lock = threading.Lock()        # only for appending to feedback.jsonl
        self.state = {"connected": False, "msg": "starting the engine..."}
        self.state_time = None                       # time.monotonic() of the engine's last authenticated state
        self.controller = None          # {"id","name","since" (wall clock, for display),"seen" (monotonic)}
        self.viewers = {}               # client id -> {"name","seen"}

        # the engine process and its link
        self.engine_lock = threading.Lock()
        self.engine = None
        self.engine_wanted = True
        self.engine_started = 0.0       # time.monotonic() when the current engine was started
        self.restart_at = None          # time.monotonic() when the page asked for a restart
        self.engine_log = []
        self.token = b""                # secret of the current engine process (a new one for every start)
        self.peer_token = None          # = token once that engine has sent us authenticated state; until then
        #                                 we send it nothing (see send())
        self.udp_drops = 0              # datagrams on the state port without the right token

        self.tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rx.bind(("127.0.0.1", args.state_port))
        self.rx.settimeout(0.5)

    # ---------------------------------------------------------------- keys
    @staticmethod
    def _load_key(path):
        """Read a key file, or create it with a new random key. The file is private to this user (mode 0600):
        anyone who can read it can drive the device (lab key) or watch (view key)."""
        path = os.path.abspath(os.path.expanduser(path))
        for _ in range(3):
            if os.path.exists(path):
                if os.name == "posix" and os.stat(path).st_mode & 0o077:
                    os.chmod(path, 0o600)            # e.g. a key the admin wrote by hand with 'echo k > key'
                with open(path) as f:
                    k = f.read().strip()
                if k:
                    return k
                os.remove(path)                      # empty file: make a new key below
            # a new folder is private too (an existing one is left as it is: the file's own mode protects it)
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            k = secrets.token_urlsafe(9)
            try:
                # O_EXCL + mode 0600: the file is private from the moment it exists (no window between
                # writing it and a chmod in which another user could open it)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                continue                             # another copy of the server made it just now: read that one
            with os.fdopen(fd, "w") as f:
                f.write(k + "\n")
            return k
        raise RuntimeError("cannot create the key file " + path)

    # ---------------------------------------------------------------- engine
    def send(self, cmd):
        """Send one command to the engine as '<token> <command>'. Returns False if there is no engine we may
        talk to. We only send once the engine has spoken first (sent state with its token): if some other
        program had grabbed the engine's UDP port, our datagrams, and with them the token, would go to it."""
        tok = self.peer_token
        if tok is None:
            return False
        try:
            self.tx.sendto(tok + b" " + cmd.encode("ascii"), ("127.0.0.1", self.args.cmd_port))
            return True
        except (OSError, UnicodeEncodeError):
            return False

    def engine_loop(self):
        while True:
            try:                                     # this thread must never die, or the engine is never restarted
                self._supervise()
            except Exception as e:
                log("engine manager error:", repr(e))
            time.sleep(1.0)

    def _supervise(self):
        p = self.engine
        now = time.monotonic()
        if p is not None and p.poll() is None:       # running: is it still talking to us?
            if not self.engine_wanted:
                return
            why = None
            if self.restart_at is not None and now - self.restart_at > ENGINE_QUIT_S and (
                    not self._engine_reporting() or now - self.restart_at > ENGINE_SAVE_S):
                why = "did not quit when asked"          # (an engine that still reports is saving a recording)
            elif self.state_time is None or self.state_time < self.engine_started:
                if now - self.engine_started > ENGINE_START_S:
                    why = ("sent no authenticated state within %.0f s of starting (%d datagrams without the right "
                           "token arrived: an engine built before the token was added?)" % (ENGINE_START_S, self.udp_drops))
            elif now - self.state_time > ENGINE_STALE_S:
                why = "sent no state for %.0f s (stuck?)" % (now - self.state_time)
            if why:
                # A stuck engine does not read UDP, so 'quit' would not help: stop the process itself.
                log("engine", why, "- stopping it and starting a new one")
                with self.changed:
                    self.state = {"connected": False, "msg": "the engine stopped responding; restarting it"}
                    self.changed.notify_all()
                self.send("forces 0")                # in case it still reads commands
                self.stop_engine(p, 0)
                self._forget_engine(p)
            return
        if not self.engine_wanted:
            return
        if p is not None:
            log("engine exited with code", p.returncode, "- restarting")
        self._start_engine()

    def _forget_engine(self, proc):
        """proc has ended: stop sending to its port and stop believing its token."""
        with self.engine_lock:
            if self.engine is proc:
                self.peer_token = None
                self.token = b""

    def _start_engine(self):
        cmd = [self.args.engine, "--data", self.data_dir, "--parent-timeout", "10",
               "--state-port", str(self.args.state_port), "--cmd-port", str(self.args.cmd_port)]
        if self.args.sim:
            cmd.append("--sim")
        if self.args.device:
            cmd += ["--port", self.args.device]
        token = secrets.token_hex(16)                # 32 hex characters, new for every engine process
        env = dict(os.environ, HAPLY_LAB_TOKEN=token)
        # Own process group / session: Ctrl+C in the server's terminal (or a SIGHUP when it closes) reaches only
        # the server, which then stops the engine in order (forces 0, quit). Otherwise both get the signal at
        # once and the engine may die before it hears 'forces 0'.
        if os.name == "posix":
            kw = {"start_new_session": True}
        else:
            kw = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        with self.engine_lock:
            if not self.engine_wanted:
                return
            self.peer_token = None
            self.token = token.encode("ascii")
            self.restart_at = None
            self.engine_started = time.monotonic()
            try:
                self.engine = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                               stderr=subprocess.STDOUT, encoding="utf-8", errors="replace",
                                               bufsize=1, env=env, **kw)
            except OSError as e:
                self.engine = None
                log("cannot start the engine:", e)
                with self.changed:
                    self.state = {"connected": False, "msg": "cannot start the engine: %s (build it first)" % e}
                    self.changed.notify_all()
                started = False
            else:
                started = True
        if not started:
            time.sleep(5)
            return
        threading.Thread(target=self._engine_output, args=(self.engine,), daemon=True).start()
        log("engine started:", " ".join(cmd))

    def _engine_reporting(self):
        """True while the engine still sends state (for example during its shutdown, while it saves a recording:
        it has already switched forces off and sent a zero force by then)."""
        return self.state_time is not None and time.monotonic() - self.state_time < 1.0

    def stop_engine(self, p, grace):
        """Make sure engine process p ends. We have usually sent it 'quit' already; give it `grace` seconds
        (longer, up to ENGINE_SAVE_S, while it keeps reporting because it is saving a recording), then ask the
        operating system to stop it (the engine catches that, too, and still sends zero force), and as the very
        last resort kill it."""
        if grace > 0:
            t0 = time.monotonic()
            while p.poll() is None:
                waited = time.monotonic() - t0
                if waited > ENGINE_SAVE_S or (waited > grace and not self._engine_reporting()):
                    break
                try:
                    p.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
            if p.poll() is not None:
                return
            grace = 0
        for step in ("wait", "ask", "kill"):
            if step == "ask":
                try:
                    if os.name == "nt":
                        os.kill(p.pid, signal.CTRL_BREAK_EVENT)   # its console handler sets the stop flag
                    else:
                        p.terminate()                              # SIGTERM -> the engine's signal handler
                except OSError:
                    pass
            elif step == "kill":
                log("engine did not stop - killing it")
                try:
                    p.kill()
                except OSError:
                    pass
            try:
                p.wait(timeout=grace if step == "wait" else 1.0)
                return
            except subprocess.TimeoutExpired:
                pass

    def shutdown(self):
        """Server is stopping (Ctrl+C, systemctl stop, SIGTERM): forces off, then the engine quits."""
        with self.engine_lock:
            self.engine_wanted = False
        p = self.engine
        sent = self.send("forces 0")
        self.send("quit")
        if p is not None and p.poll() is None:
            self.stop_engine(p, ENGINE_QUIT_S if sent else 0)
            log("engine stopped (exit code %s)" % p.returncode)
        if p is not None:
            self._forget_engine(p)

    def _engine_output(self, proc):
        try:
            for line in proc.stdout:                 # keep reading, or the engine blocks once the pipe is full
                line = line.rstrip()
                log("[engine]", line)
                self.engine_log = (self.engine_log + [line])[-50:]
        except (OSError, ValueError):
            pass
        try:
            proc.wait(timeout=2)                     # its output ended: it is exiting (or has exited)
        except subprocess.TimeoutExpired:
            return
        self._forget_engine(proc)                    # right away, not at the next check one second later

    def udp_loop(self):
        while True:
            try:
                data = self.rx.recv(65535)
            except socket.timeout:
                continue
            except OSError:
                time.sleep(0.1)
                continue
            try:
                self._state_datagram(data)
            except Exception as e:                   # one strange datagram must not stop the state flowing
                log("bad state datagram:", repr(e))

    def _state_datagram(self, data):
        tok = self.token
        head, _, body = data.partition(b" ")
        if not tok or not hmac.compare_digest(head, tok):
            self.udp_drops += 1                      # forged, from an old engine, or an engine without a token
            return
        try:
            st = json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            return
        if not isinstance(st, dict):
            return
        with self.engine_lock:
            if self.token is not tok:                # a new engine was started meanwhile
                return
            if self.peer_token is None:
                self.peer_token = tok
                log("engine is talking (authenticated link)")
        with self.changed:
            self.state = st
            self.state_time = time.monotonic()
            self.changed.notify_all()

    def snapshot(self, client, role):
        """The engine state for one page: plus who is in control, and how old the engine's state is (s)."""
        with self.lock:
            st = dict(self.state)
            t = self.state_time
        st["control"] = self.control_info(client, role)
        st["age"] = round(time.monotonic() - t, 3) if t is not None else 1e6   # 1e6: never heard from it
        return st

    # ---------------------------------------------------------------- control + heartbeat
    def heartbeat_loop(self):
        last_alive = -1e9
        while True:
            try:
                now = time.monotonic()
                if now - last_alive > 1.0:           # tells the engine the server still exists (else it stops itself)
                    self.send("alive")
                    last_alive = now
                with self.lock:
                    c = self.controller
                    if c and now - c["seen"] > CONTROL_LEASE_S:
                        log("control released (page went quiet):", c["name"])
                        self.controller = None
                        c = None
                        self.send("forces 0")
                    alive = c is not None and now - c["seen"] < HB_ALIVE_S
                    for cid in [k for k, v in self.viewers.items() if now - v["seen"] > 10]:
                        del self.viewers[cid]
                if alive:
                    self.send("hb")
            except Exception as e:
                log("heartbeat error:", repr(e))
            time.sleep(HB_PERIOD_S)

    def control_info(self, client=None, role="control"):
        now = time.monotonic()
        with self.lock:
            c = self.controller
            return {
                "holder": c["name"] if c else None,
                "since": c["since"] if c else None,
                "you": bool(role == "control" and c and client and c["id"] == client),
                "watching": len([v for v in self.viewers.values() if now - v["seen"] < 10]),
                "names": sorted({v["name"] for v in self.viewers.values() if now - v["seen"] < 10}),
            }

    def ping(self, client, name, role):
        now = time.monotonic()
        with self.lock:
            if client in self.viewers or len(self.viewers) < MAX_VIEWERS:
                self.viewers[client] = {"name": name or "someone", "seen": now}
            # only a lab-key page keeps its control alive: the view key never holds (or keeps) control
            if role == "control" and self.controller and self.controller["id"] == client:
                self.controller["seen"] = now

    def take(self, client, name):
        now = time.monotonic()
        with self.lock:
            c = self.controller
            if c is None or c["id"] == client or now - c["seen"] > CONTROL_LEASE_S:
                self.controller = {"id": client, "name": name or "someone", "since": time.time(), "seen": now}
                log("control taken by", self.controller["name"])
                return True, None
            return False, c["name"]

    def release(self, client):
        with self.lock:
            if self.controller and self.controller["id"] == client:
                log("control released by", self.controller["name"])
                self.controller = None
                self.send("forces 0")
                return True
        return False

    def send_as_controller(self, client, cmds):
        """Send commands only if `client` is in control. The check and the sending happen under one lock, so a
        'release' (or someone else taking over) cannot slip in between them. Returns None if not in control,
        else whether the engine could be reached."""
        with self.lock:
            if not (self.controller and self.controller["id"] == client):
                return None
            ok = True
            for c in cmds:
                ok = self.send(c) and ok
            return ok

    def stop_forces(self, name, client, role, addr):
        """The stop button: anyone with either key may switch forces off, at any time."""
        sent = self.send("forces 0")
        log("STOP pressed by %s (%s key, client %s, from %s)%s"
            % (name or "someone", role, client or "-", addr, "" if sent else " - but no engine is running"))
        return sent

    # ---------------------------------------------------------------- files
    def recordings(self):
        out = []
        for p in sorted(glob.glob(os.path.join(self.data_dir, "*.csv")), reverse=True):
            name = os.path.basename(p)
            meta = {}
            side = p[:-4] + ".json"
            if os.path.exists(side):
                try:
                    with open(side) as f:
                        meta = json.load(f)
                except (OSError, ValueError):
                    meta = {}
            if not isinstance(meta, dict):
                meta = {}
            scen = ""
            try:
                with open(p, encoding="utf-8", errors="replace") as f:
                    for _ in range(6):
                        line = f.readline()
                        if line.startswith("# scenario:"):
                            scen = line[len("# scenario:"):].strip()
                st = os.stat(p)
            except OSError:                          # deleted while we were listing
                continue
            out.append({"name": name, "bytes": st.st_size, "mtime": st.st_mtime, "scenario": scen,
                        "notes": str(meta.get("notes", "")), "author": str(meta.get("author", ""))})
        return out

    def recording_path(self, name):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+\.csv", name or ""):
            return None
        p = os.path.join(self.data_dir, name)
        return p if os.path.exists(p) else None

    @staticmethod
    def source_files():
        files = set()
        for g in SOURCE_GLOBS:
            for p in glob.glob(os.path.join(REPO, g)):
                if os.path.isfile(p) and p.endswith(SOURCE_EXT) or os.path.basename(p) == "CMakeLists.txt":
                    files.add(os.path.relpath(p, REPO).replace(os.sep, "/"))
        return sorted(files)

    def source(self, rel):
        if rel not in self.source_files():
            return None
        with open(os.path.join(REPO, rel), encoding="utf-8", errors="replace") as f:
            return f.read()

    def add_feedback(self, item):
        item = {k: str(item.get(k, ""))[:4000] for k in ("kind", "where", "text", "name", "page", "line")}
        item["time"] = datetime.datetime.now().isoformat(timespec="seconds")
        # its own lock, not self.lock: a slow SD card write must never delay the heartbeat
        with self.feedback_lock:
            with open(self.feedback_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(item) + "\n")
        log("feedback:", item["kind"], item["where"], item["text"][:80])

    def feedback(self, limit=200):
        if not os.path.exists(self.feedback_file):
            return []
        items = []
        with open(self.feedback_file, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    items.append(json.loads(line))
                except ValueError:                   # blank, or half-written when the power went off: skip it
                    pass
        return items[-limit:][::-1]

    # ---------------------------------------------------------------- LabTV (optional)
    def tv(self, action, url=None):
        """Show the big-screen view on the lab TV through LabTV (the Pi's own HDMI output, whose Chromium
        renders the equations; the old Chromecast cannot), or put the TV back to the LabTV clock."""
        labtv = os.path.expanduser(self.args.labtv)
        if not os.path.exists(labtv):
            return False, "LabTV is not installed on this computer"
        if action == "show":
            steps = [[labtv, "page", url, "--on", "local"], [labtv, "tv", "local"]]
        elif action == "off":
            steps = [[labtv, "idle", "--on", "local"]]
        else:
            return False, "unknown TV action"
        out = []
        for cmd in steps:
            try:
                r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, timeout=25,
                                   cwd=os.path.dirname(os.path.dirname(labtv)))
                out.append(r.stdout.strip())
                if r.returncode != 0:
                    return False, "\n".join(out)[-400:]
            except (OSError, subprocess.TimeoutExpired) as e:
                return False, str(e)
        log("TV:", action)
        return True, "\n".join(out)[-400:]


def make_handler(lab):
    class Handler(BaseHTTPRequestHandler):
        server_version = "HaplyLab/1.0"
        protocol_version = "HTTP/1.0"
        timeout = HTTP_TIMEOUT_S        # without it, a client that connects and sends nothing holds a thread forever

        def log_message(self, fmt, *args):     # quiet: the stream would flood the log
            pass

        def send_response(self, code, message=None):
            self._answered = True
            BaseHTTPRequestHandler.send_response(self, code, message)

        # Every request runs inside _guard: whatever goes wrong, the browser gets a JSON answer (400/413/500)
        # instead of a connection that just drops, and the server log gets the traceback.
        def do_GET(self):
            self._guard(self._get)

        def do_POST(self):
            self._guard(self._post)

        def _guard(self, handler):
            self._answered = False
            try:
                handler()
            except BadRequest as e:
                if not self._answered:
                    self._json({"error": e.msg}, e.code)
                self.close_connection = True
            except (ConnectionError, socket.timeout):
                self.close_connection = True                  # the browser went away: nobody to answer
            except Exception as e:
                log("error in %s %s: %r\n%s" % (self.command, self.path[:120], e, traceback.format_exc()))
                if not self._answered:
                    try:
                        self._json({"error": "server error (%s); see the server log" % type(e).__name__}, 500)
                    except OSError:
                        pass
                self.close_connection = True

        # ---------------------------------------------------------- helpers
        def _query(self):
            return parse_qs(urlparse(self.path).query)

        def _role(self):
            """'control' for the lab key, 'view' for the view key, None for anything else."""
            k = self.headers.get("X-Lab-Key") or (self._query().get("key") or [""])[0]
            k = k.encode("utf-8", "replace")      # compare bytes: compare_digest refuses non-ASCII text
            if hmac.compare_digest(k, lab.key_b):
                return "control"
            if hmac.compare_digest(k, lab.view_key_b):
                return "view"
            return None

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            """The request's JSON object. A missing body is {}; anything else that is not a JSON object fails."""
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise BadRequest(400, "bad Content-Length")
            if n < 0:                                  # read(-1) would read until the client stops sending
                raise BadRequest(400, "bad Content-Length")
            if n > MAX_BODY:
                raise BadRequest(413, "request too large")
            raw = self.rfile.read(n) if n else b""
            try:
                b = json.loads(raw.decode("utf-8") or "{}")
            except ValueError:
                raise BadRequest(400, "the request body is not valid JSON")
            if not isinstance(b, dict):
                raise BadRequest(400, "the request body must be a JSON object")
            return b

        # ---------------------------------------------------------- GET
        def _get(self):
            path = urlparse(self.path).path
            if path == "/term":
                return self._terminal()
            if not path.startswith("/api/"):
                return self._static(path)
            role = self._role()
            if role is None:
                return self._json({"error": "this needs the lab key: open the link your instructor gave you"}, 403)
            if role == "view" and path not in VIEW_GET:
                return self._json({"error": "this is a watch-only link: that needs the lab key"}, 403)
            q = self._query()
            client = client_id((q.get("client") or [""])[0])
            if path == "/api/hello":
                hello = {"ok": True, "role": role, "host": socket.gethostname(), "sim": lab.args.sim, "github": GITHUB,
                         "terminal": lab.args.term_port > 0, "tv": os.path.exists(os.path.expanduser(lab.args.labtv))}
                if role == "control":
                    hello["view_key"] = lab.view_key        # for the TV and 'watch only' links
                return self._json(hello)
            if path == "/api/state":
                return self._json(lab.snapshot(client, role))
            if path == "/api/stream":
                return self._stream(client, role)
            if path == "/api/recordings":
                return self._json(lab.recordings())
            if path.startswith("/api/recordings/"):
                p = lab.recording_path(unquote(path[len("/api/recordings/"):]))
                if not p:
                    return self._json({"error": "no such recording"}, 404)
                return self._file(p, "text/csv", download=os.path.basename(p))
            if path == "/api/files":
                return self._json(lab.source_files())
            if path == "/api/source":
                rel = (q.get("path") or [""])[0]
                text = lab.source(rel)
                if text is None:
                    return self._json({"error": "not an explorable file"}, 404)
                return self._json({"path": rel, "text": text, "github": "%s/blob/main/%s" % (GITHUB, rel)})
            if path == "/api/feedback":
                return self._json(lab.feedback())
            if path == "/api/engine_log":
                return self._json(lab.engine_log)
            return self._json({"error": "unknown endpoint"}, 404)

        def _stream(self, client, role):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            # a write that cannot go out for this long (the laptop went to sleep) ends the stream
            self.connection.settimeout(SSE_WRITE_TIMEOUT_S)
            last_sent = 0.0
            try:
                while True:
                    with lab.changed:
                        lab.changed.wait(timeout=1.0)   # also wakes every second, so a stuck engine shows a growing age
                    now = time.monotonic()
                    if now - last_sent < 0.033:       # ~30 updates per second per page is plenty for the eye
                        continue
                    last_sent = now
                    self.wfile.write(("data: %s\n\n" % json.dumps(lab.snapshot(client, role))).encode())
                    self.wfile.flush()
            except OSError:                           # includes BrokenPipe, ConnectionReset and socket.timeout
                self.close_connection = True

        def _static(self, path):
            if path in ("", "/"):
                path = "/index.html"
            rel = os.path.normpath(unquote(path).lstrip("/"))
            full = os.path.abspath(os.path.join(WEB_ROOT, rel))
            if not full.startswith(WEB_ROOT + os.sep) or not os.path.isfile(full):
                self.send_error(404)
                return
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if full.endswith(".md"):
                ctype = "text/markdown; charset=utf-8"
            return self._file(full, ctype)

        def _file(self, full, ctype, download=None):
            # Streamed in 64 kB pieces: a 10-minute recording is ~120 MB, and a class downloading at once must
            # not need that much memory per download.
            with open(full, "rb") as f:
                size = os.fstat(f.fileno()).st_size
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-cache")
                if download:
                    self.send_header("Content-Disposition", 'attachment; filename="%s"' % download)
                self.end_headers()
                left = size                           # never more than we announced, even if the file grows
                while left > 0:
                    chunk = f.read(min(65536, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            self.close_connection = True

        # ---------------------------------------------------------- POST
        def _post(self):
            path = urlparse(self.path).path
            if not path.startswith("/api/"):
                return self._json({"error": "unknown endpoint"}, 404)
            role = self._role()
            if role is None:
                return self._json({"error": "this needs the lab key"}, 403)
            if role == "view" and path not in VIEW_POST:
                return self._json({"error": "this is a watch-only link: that needs the lab key"}, 403)
            if path == "/api/stop":
                try:                                  # a stop must never fail because of a malformed body
                    b = self._body()
                except BadRequest:
                    b = {}
                    self.close_connection = True      # the unread body would confuse the next request
            else:
                b = self._body()
            client = client_id(b.get("client"))
            name = re.sub(r"[^\w .@-]", "", str(b.get("name", "")))[:40]
            if path == "/api/stop":                   # the stop button: either key, no control needed
                ok = lab.stop_forces(name, client, role, self.client_address[0])
                if not ok:
                    return self._json({"ok": False, "error": "the engine is not running (so there are no forces)"}, 503)
                return self._json({"ok": True})
            if path in ("/api/ping", "/api/control", "/api/cmd", "/api/engine") and not client:
                return self._json({"error": "missing or malformed client id"}, 400)
            if path == "/api/ping":
                lab.ping(client, name, role)
                return self._json(lab.control_info(client, role))
            if path == "/api/control":
                if b.get("action") == "take":
                    ok, holder = lab.take(client, name)
                    lab.ping(client, name, role)
                    return self._json({"ok": ok, "holder": holder, "control": lab.control_info(client)}, 200 if ok else 409)
                if b.get("action") == "release":
                    return self._json({"ok": lab.release(client), "control": lab.control_info(client)})
                return self._json({"error": "action must be take or release"}, 400)
            if path == "/api/cmd":
                cmds = b.get("cmds")
                if not isinstance(cmds, list) or len(cmds) > MAX_CMDS:
                    return self._json({"error": "cmds must be a list of at most %d commands" % MAX_CMDS}, 400)
                bad = [c for c in cmds if not isinstance(c, str) or not any(p.fullmatch(c) for p in CMD_PATTERNS)]
                if bad:
                    return self._json({"error": "not allowed: %s" % str(bad[0])[:80]}, 400)
                return self._sent(lab.send_as_controller(client, cmds))
            if path == "/api/engine":
                action = b.get("action")
                if action in ("release", "acquire"):
                    return self._sent(lab.send_as_controller(client, ["device " + action]))
                if action == "restart":
                    ok = lab.send_as_controller(client, ["forces 0", "quit"])
                    if ok is not None:
                        lab.restart_at = time.monotonic()     # if it does not quit, the supervisor stops it
                    return self._sent(True if ok is not None else None)
                return self._json({"error": "unknown action"}, 400)
            if path.startswith("/api/recordings/") and path.endswith("/notes"):
                p = lab.recording_path(unquote(path[len("/api/recordings/"):-len("/notes")]))
                if not p:
                    return self._json({"error": "no such recording"}, 404)
                with open(p[:-4] + ".json", "w") as f:
                    json.dump({"notes": str(b.get("notes", ""))[:20000], "author": name}, f)
                return self._json({"ok": True})
            if path == "/api/feedback":
                if not str(b.get("text", "")).strip():
                    return self._json({"error": "empty feedback"}, 400)
                b["name"] = name
                lab.add_feedback(b)
                return self._json({"ok": True})
            if path == "/api/tv":
                host = self.headers.get("Host", "localhost:%d" % lab.args.port).split(":")[0]
                # The TV gets the view key: its link can be read off the screen (and off LabTV's command
                # line with ps), so it must not be able to drive the device.
                url = "http://127.0.0.1:%d/?key=%s&view=tv" % (lab.args.port, quote(lab.view_key))
                ok, out = lab.tv(b.get("action", ""), url)
                return self._json({"ok": ok, "output": out, "host": host}, 200 if ok else 500)
            return self._json({"error": "unknown endpoint"}, 404)

        def _sent(self, ok):
            if ok is None:
                return self._json({"error": "take control first (only one person drives the device at a time)"}, 409)
            if not ok:
                return self._json({"error": "the engine is (re)starting; try again in a few seconds"}, 503)
            return self._json({"ok": True})

        # ---------------------------------------------------------- terminal relay
        def _terminal(self):
            """Hand the WebSocket over to lab/haply_term.py (running as the 'student' user)."""
            if self._role() != "control":
                self.send_error(403)
                return
            if lab.args.term_port <= 0 or self.headers.get("Upgrade", "").lower() != "websocket":
                self.send_error(404)
                return
            try:
                up = socket.create_connection(("127.0.0.1", lab.args.term_port), timeout=3)
            except OSError:
                self.send_error(503, "the terminal service is not running")
                return
            up.settimeout(None)
            client = self.connection
            client.settimeout(None)       # a terminal may sit idle for long (haply_term closes it after an hour)...
            keepalive(client)             # ...but a laptop that vanished is noticed within a few minutes
            # Forward the browser's headers and add X-Haply-Relay. haply_term.py refuses a WebSocket without it,
            # and a browser cannot add custom headers to a WebSocket, so a web page cannot open
            # ws://127.0.0.1:8781 on the Pi itself and get a shell without the lab key.
            hdrs = [(k, v) for k, v in self.headers.items() if k.lower() not in ("x-haply-relay", "x-lab-key")]
            req = ("GET /term HTTP/1.1\r\n" + "".join("%s: %s\r\n" % kv for kv in hdrs)
                   + "X-Haply-Relay: 1\r\n\r\n")
            up.sendall(req.encode("latin-1", "replace"))

            def pump(src, dst):
                try:
                    while True:
                        d = src.recv(65536)
                        if not d:
                            break
                        dst.sendall(d)
                except OSError:
                    pass
                for s in (src, dst):
                    try:
                        s.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

            t = threading.Thread(target=pump, args=(up, client), daemon=True)
            t.start()
            pump(client, up)
            t.join(timeout=2)
            up.close()
            self.close_connection = True

    return Handler


class Server(ThreadingHTTPServer):
    request_queue_size = 128         # the default (5) refuses connections when a class of laptops reconnects at once
    daemon_threads = True

    def __init__(self, *a, **kw):
        self.per_ip, self.per_ip_lock = {}, threading.Lock()
        ThreadingHTTPServer.__init__(self, *a, **kw)

    # One thread per connection, started before any key check: cap the connections per address, so one
    # machine opening hundreds of idle connections cannot use up all threads and file descriptors.
    def process_request(self, request, client_address):
        ip = client_address[0]
        with self.per_ip_lock:
            n = self.per_ip.get(ip, 0)
            if n < MAX_CONN_PER_IP:
                self.per_ip[ip] = n + 1
        if n >= MAX_CONN_PER_IP:
            self.shutdown_request(request)
            return
        try:
            ThreadingHTTPServer.process_request(self, request, client_address)
        except BaseException:        # e.g. no thread could be started
            self._release(ip)
            raise

    def process_request_thread(self, request, client_address):
        try:
            ThreadingHTTPServer.process_request_thread(self, request, client_address)
        finally:
            self._release(client_address[0])

    def _release(self, ip):
        with self.per_ip_lock:
            n = self.per_ip.get(ip, 1) - 1
            if n > 0:
                self.per_ip[ip] = n
            else:
                self.per_ip.pop(ip, None)


def lan_addresses():
    out = []
    try:
        res = subprocess.run(["hostname", "-I"], stdout=subprocess.PIPE, universal_newlines=True, timeout=2)
        out = res.stdout.split()
    except (OSError, subprocess.TimeoutExpired):
        pass
    if not out:
        try:
            out = [socket.gethostbyname(socket.gethostname())]
        except OSError:
            pass
    return [a for a in out if ":" not in a]


STOP_SIGNALS = ("SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK")


_stopping = []


def _on_stop_signal(signum, frame):
    # The first stop signal ends serve_forever() like Ctrl+C, and the 'finally' in main() stops the engine in
    # order. Any further signal (a second Ctrl+C, systemd's SIGTERM) is ignored, so it cannot interrupt that
    # clean stop halfway through.
    if _stopping:
        return
    _stopping.append(signum)
    raise KeyboardInterrupt


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8780)
    exe = "haply_lab_engine.exe" if os.name == "nt" else "haply_lab_engine"
    ap.add_argument("--engine", default=os.path.join(REPO, "build", exe))
    ap.add_argument("--device", default="", help="serial port of the Inverse3 (default: auto)")
    ap.add_argument("--sim", action="store_true", help="run the engine's simulator instead of the device")
    ap.add_argument("--data", default="~/haply-lab/data")
    ap.add_argument("--feedback", default="~/haply-lab/feedback")
    ap.add_argument("--key-file", default="~/.config/haply-lab/key")
    ap.add_argument("--view-key-file", default="", help="read-only key (default: 'viewkey' next to the key file)")
    ap.add_argument("--state-port", type=int, default=47001)
    ap.add_argument("--cmd-port", type=int, default=47002)
    ap.add_argument("--term-port", type=int, default=8781, help="lab/haply_term.py port (0 = no terminal)")
    ap.add_argument("--labtv", default="~/labtv/bin/labtv")
    args = ap.parse_args()

    # systemctl stop/restart sends SIGTERM, closing the terminal SIGHUP: without a handler Python would just
    # die, and the engine would never hear 'forces 0' and 'quit'.
    for name in STOP_SIGNALS:
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), _on_stop_signal)
            except (OSError, ValueError, RuntimeError):
                pass

    lab = Lab(args)
    httpd = None
    try:
        for target in (lab.engine_loop, lab.udp_loop, lab.heartbeat_loop):
            threading.Thread(target=target, daemon=True).start()
        httpd = Server((args.host, args.port), make_handler(lab))
        log("Haply lab console on port %d%s" % (args.port, " (SIMULATOR)" if args.sim else ""))
        addrs = lan_addresses() + ["localhost"]
        for a in addrs:
            log("   open:  http://%s:%d/?key=%s" % (a, args.port, lab.key))
        log("   watch only (TV, projector):  http://%s:%d/?key=%s" % (addrs[0], args.port, lab.view_key))
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for name in STOP_SIGNALS:              # a second Ctrl+C must not cut the clean stop short
            if hasattr(signal, name):
                try:
                    signal.signal(getattr(signal, name), signal.SIG_IGN)
                except (OSError, ValueError, RuntimeError):
                    pass
        log("stopping: forces off, engine quits")
        lab.shutdown()
        if httpd is not None:
            httpd.server_close()


if __name__ == "__main__":
    main()
