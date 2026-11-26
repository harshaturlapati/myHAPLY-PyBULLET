#!/usr/bin/env python3
"""haply_lab.py - the web half of the Haply lab console (Python 3.8+, standard library only).

It is NOT in the haptic loop. The C++ engine (build/haply_lab_engine) owns the Haply and runs the 1 kHz
loop; this server only
  * starts the engine and relays its ~100 Hz state to browsers (Server-Sent Events, ~30 Hz per page),
  * passes the controlling student's commands to the engine (UDP on 127.0.0.1),
  * keeps one student in control at a time, and sends the engine a heartbeat only while that student's
    page is alive (if the page dies, the engine's watchdog switches forces off within 1 s),
  * lists and serves recordings, serves source files read-only for the code explorer, stores feedback,
  * relays the in-page terminal to lab/haply_term.py (which runs as the restricted 'student' user),
  * serves the web app itself (the repository's docs/ folder, the same files as GitHub Pages).

Every /api/ call needs the lab key (?key=... in the link the instructor hands out).

    python3 lab/haply_lab.py                       # real device
    python3 lab/haply_lab.py --sim                 # simulator, no device needed
"""

import argparse
import datetime
import glob
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from http import HTTPStatus
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

CONTROL_LEASE_S = 3.0      # controller must ping at least this often or loses control
HB_PERIOD_S = 0.2          # heartbeat to the engine while the controller is alive
HB_ALIVE_S = 1.0           # controller ping younger than this -> heartbeat is sent

FLOAT = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
CMD_PATTERNS = [
    re.compile(r"^forces [01]$"),
    re.compile(r"^set kind (free|impedance|wall|custom)$"),
    re.compile(r"^set (xd|rpy|k|b) %s %s %s$" % (FLOAT, FLOAT, FLOAT)),
    re.compile(r"^set fmax %s$" % FLOAT),
    re.compile(r"^expr (fx|fy|fz) [ -~]{0,240}$"),
    re.compile(r"^rec (start [A-Za-z0-9 _-]{0,60}|stop)$"),
    re.compile(r"^sim %s %s %s$" % (FLOAT, FLOAT, FLOAT)),
]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Lab:
    """Shared state between the HTTP threads, the UDP receiver and the engine manager."""

    def __init__(self, args):
        self.args = args
        self.key = self._load_key(args.key_file)
        self.data_dir = os.path.abspath(os.path.expanduser(args.data))
        self.feedback_file = os.path.join(os.path.abspath(os.path.expanduser(args.feedback)), "feedback.jsonl")
        os.makedirs(self.data_dir, exist_ok=True)
        os.makedirs(os.path.dirname(self.feedback_file), exist_ok=True)

        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.state = {"connected": False, "msg": "starting the engine..."}
        self.state_time = 0.0
        self.controller = None          # {"id","name","since","seen"}
        self.viewers = {}               # client id -> {"name","seen"}
        self.engine = None
        self.engine_wanted = True
        self.engine_log = []

        self.tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rx.bind(("127.0.0.1", args.state_port))
        self.rx.settimeout(0.5)

    # ---------------------------------------------------------------- key
    @staticmethod
    def _load_key(path):
        path = os.path.expanduser(path)
        if os.path.exists(path):
            with open(path) as f:
                k = f.read().strip()
            if k:
                return k
        os.makedirs(os.path.dirname(path), exist_ok=True)
        k = secrets.token_urlsafe(9)
        with open(path, "w") as f:
            f.write(k + "\n")
        os.chmod(path, 0o600)
        return k

    # ---------------------------------------------------------------- engine
    def send(self, cmd):
        self.tx.sendto(cmd.encode("ascii", "replace"), ("127.0.0.1", self.args.cmd_port))

    def engine_loop(self):
        while True:
            if self.engine_wanted and (self.engine is None or self.engine.poll() is not None):
                if self.engine is not None:
                    log("engine exited with code", self.engine.returncode, "- restarting")
                cmd = [self.args.engine, "--data", self.data_dir, "--parent-timeout", "10",
                       "--state-port", str(self.args.state_port), "--cmd-port", str(self.args.cmd_port)]
                if self.args.sim:
                    cmd.append("--sim")
                if self.args.device:
                    cmd += ["--port", self.args.device]
                try:
                    self.engine = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                                   universal_newlines=True, bufsize=1)
                    threading.Thread(target=self._engine_output, args=(self.engine,), daemon=True).start()
                    log("engine started:", " ".join(cmd))
                except OSError as e:
                    with self.lock:
                        self.state = {"connected": False, "msg": "cannot start the engine: %s (build it first)" % e}
                    time.sleep(5)
            time.sleep(1.0)

    def _engine_output(self, proc):
        for line in proc.stdout:
            line = line.rstrip()
            log("[engine]", line)
            self.engine_log = (self.engine_log + [line])[-50:]

    def udp_loop(self):
        while True:
            try:
                data = self.rx.recv(16384)
            except socket.timeout:
                continue
            except OSError:
                time.sleep(0.1)
                continue
            try:
                st = json.loads(data.decode())
            except ValueError:
                continue
            with self.changed:
                self.state = st
                self.state_time = time.time()
                self.changed.notify_all()

    # ---------------------------------------------------------------- control + heartbeat
    def heartbeat_loop(self):
        last_alive = 0.0
        while True:
            now = time.time()
            if now - last_alive > 1.0:          # tells the engine the server still exists (else it stops itself)
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
            time.sleep(HB_PERIOD_S)

    def control_info(self, client=None):
        now = time.time()
        with self.lock:
            c = self.controller
            return {
                "holder": c["name"] if c else None,
                "since": c["since"] if c else None,
                "you": bool(c and client and c["id"] == client),
                "watching": len([v for v in self.viewers.values() if now - v["seen"] < 10]),
                "names": sorted({v["name"] for v in self.viewers.values() if now - v["seen"] < 10}),
            }

    def ping(self, client, name):
        now = time.time()
        with self.lock:
            self.viewers[client] = {"name": name or "someone", "seen": now}
            if self.controller and self.controller["id"] == client:
                self.controller["seen"] = now

    def take(self, client, name):
        now = time.time()
        with self.lock:
            c = self.controller
            if c is None or c["id"] == client or now - c["seen"] > CONTROL_LEASE_S:
                self.controller = {"id": client, "name": name or "someone", "since": now, "seen": now}
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

    def is_controller(self, client):
        with self.lock:
            return bool(self.controller and self.controller["id"] == client)

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
            scen = ""
            try:
                with open(p) as f:
                    for _ in range(6):
                        line = f.readline()
                        if line.startswith("# scenario:"):
                            scen = line[len("# scenario:"):].strip()
            except OSError:
                pass
            st = os.stat(p)
            out.append({"name": name, "bytes": st.st_size, "mtime": st.st_mtime, "scenario": scen,
                        "notes": meta.get("notes", ""), "author": meta.get("author", "")})
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
        with self.lock:
            with open(self.feedback_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(item) + "\n")
        log("feedback:", item["kind"], item["where"], item["text"][:80])

    def feedback(self, limit=200):
        if not os.path.exists(self.feedback_file):
            return []
        with open(self.feedback_file, encoding="utf-8") as f:
            items = [json.loads(l) for l in f if l.strip()]
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

        def log_message(self, fmt, *args):     # quiet: the stream would flood the log
            pass

        # ---------------------------------------------------------- helpers
        def _query(self):
            return parse_qs(urlparse(self.path).query)

        def _key_ok(self):
            k = self.headers.get("X-Lab-Key") or (self._query().get("key") or [""])[0]
            return secrets.compare_digest(k, lab.key)

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 200000:
                return {}
            try:
                return json.loads(self.rfile.read(n).decode() or "{}")
            except ValueError:
                return {}

        # ---------------------------------------------------------- GET
        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/term":
                return self._terminal()
            if not path.startswith("/api/"):
                return self._static(path)
            if not self._key_ok():
                return self._json({"error": "this needs the lab key: open the link your instructor gave you"}, 403)
            q = self._query()
            client = (q.get("client") or [""])[0]
            if path == "/api/hello":
                return self._json({"ok": True, "host": socket.gethostname(), "sim": lab.args.sim, "github": GITHUB,
                                   "terminal": lab.args.term_port > 0, "tv": os.path.exists(os.path.expanduser(lab.args.labtv))})
            if path == "/api/state":
                with lab.lock:
                    st = dict(lab.state)
                st["control"] = lab.control_info(client)
                st["age"] = time.time() - lab.state_time
                return self._json(st)
            if path == "/api/stream":
                return self._stream(client)
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

        def _stream(self, client):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            last_sent = 0.0
            try:
                while True:
                    with lab.changed:
                        lab.changed.wait(timeout=1.0)
                        st = dict(lab.state)
                    now = time.time()
                    if now - last_sent < 0.033:       # ~30 updates per second per page is plenty for the eye
                        continue
                    last_sent = now
                    st["control"] = lab.control_info(client)
                    st["age"] = now - lab.state_time
                    self.wfile.write(("data: %s\n\n" % json.dumps(st)).encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                return

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
            with open(full, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            if download:
                self.send_header("Content-Disposition", 'attachment; filename="%s"' % download)
            self.end_headers()
            self.wfile.write(body)

        # ---------------------------------------------------------- POST
        def do_POST(self):
            path = urlparse(self.path).path
            if not path.startswith("/api/") or not self._key_ok():
                return self._json({"error": "this needs the lab key"}, 403)
            b = self._body()
            client = str(b.get("client", ""))[:64]
            name = re.sub(r"[^\w .@-]", "", str(b.get("name", "")))[:40]
            if path == "/api/ping":
                lab.ping(client, name)
                return self._json(lab.control_info(client))
            if path == "/api/control":
                if b.get("action") == "take":
                    ok, holder = lab.take(client, name)
                    lab.ping(client, name)
                    return self._json({"ok": ok, "holder": holder, "control": lab.control_info(client)}, 200 if ok else 409)
                if b.get("action") == "release":
                    return self._json({"ok": lab.release(client), "control": lab.control_info(client)})
                return self._json({"error": "action must be take or release"}, 400)
            if path == "/api/cmd":
                if not lab.is_controller(client):
                    return self._json({"error": "take control first (only one person drives the device at a time)"}, 409)
                cmds = b.get("cmds") or []
                bad = [c for c in cmds if not isinstance(c, str) or not any(p.match(c) for p in CMD_PATTERNS)]
                if bad:
                    return self._json({"error": "not allowed: %s" % bad[0]}, 400)
                for c in cmds[:20]:
                    lab.send(c)
                return self._json({"ok": True})
            if path == "/api/engine":
                if not lab.is_controller(client):
                    return self._json({"error": "take control first"}, 409)
                action = b.get("action")
                if action in ("release", "acquire"):
                    lab.send("device " + action)
                    return self._json({"ok": True})
                if action == "restart":
                    lab.send("quit")
                    return self._json({"ok": True})
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
                url = "http://127.0.0.1:%d/?key=%s&view=tv" % (lab.args.port, quote(lab.key))
                ok, out = lab.tv(b.get("action", ""), url)
                return self._json({"ok": ok, "output": out, "host": host}, 200 if ok else 500)
            return self._json({"error": "unknown endpoint"}, 404)

        # ---------------------------------------------------------- terminal relay
        def _terminal(self):
            """Hand the WebSocket over to lab/haply_term.py (running as the 'student' user)."""
            if not self._key_ok():
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
            req = "GET /term HTTP/1.1\r\n" + "".join("%s: %s\r\n" % (k, v) for k, v in self.headers.items()) + "\r\n"
            up.sendall(req.encode())
            client = self.connection

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
            self.close_connection = True

    return Handler


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
    ap.add_argument("--state-port", type=int, default=47001)
    ap.add_argument("--cmd-port", type=int, default=47002)
    ap.add_argument("--term-port", type=int, default=8781, help="lab/haply_term.py port (0 = no terminal)")
    ap.add_argument("--labtv", default="~/labtv/bin/labtv")
    args = ap.parse_args()

    lab = Lab(args)
    for target in (lab.engine_loop, lab.udp_loop, lab.heartbeat_loop):
        threading.Thread(target=target, daemon=True).start()

    class Server(ThreadingHTTPServer):
        request_queue_size = 128         # the default (5) refuses connections when a class of laptops reconnects at once
        daemon_threads = True
    httpd = Server((args.host, args.port), make_handler(lab))
    log("Haply lab console on port %d%s" % (args.port, " (SIMULATOR)" if args.sim else ""))
    for a in lan_addresses() + ["localhost"]:
        log("   open:  http://%s:%d/?key=%s" % (a, args.port, lab.key))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        lab.engine_wanted = False
        lab.send("forces 0")
        lab.send("quit")


if __name__ == "__main__":
    main()
