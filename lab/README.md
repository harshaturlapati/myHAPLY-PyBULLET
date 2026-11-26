# Haply lab console

A web page that lets students drive the Haply Inverse3, learn the equations of haptic interaction, record
experiments, read the C++ that runs the device, and turn it all into a report, without writing code first.

```
 browser (any laptop on the lab Wi-Fi)                      lab Raspberry Pi
 ┌─────────────────────────────┐   HTTP / SSE   ┌───────────────────────────┐  UDP 127.0.0.1  ┌──────────────────────────┐   USB
 │ docs/index.html + app.js    │ ─────────────► │ lab/haply_lab.py (Python) │ ──────────────► │ build/haply_lab_engine   │ ────► Inverse3
 │ Play, Learn, Code, Report…  │ ◄───────────── │ control lock, recordings, │ ◄────────────── │ 1 kHz loop, equations,   │ ◄────
 └─────────────────────────────┘   ~30 Hz       │ code browser, feedback    │   100 Hz state  │ safety layers (C++)      │
               │  WebSocket                     └───────────────────────────┘                 └──────────────────────────┘
               └──── Terminal tab ─────────────► lab/haply_term.py (runs as the restricted 'student' user)
```

**Real time stays in C++.** `haply_lab_engine` owns the device and runs read → equation → force at 1 kHz on its own
CPU core at real-time priority. The Python server is never in that loop: it relays a ~30 Hz copy of the state to the
browsers and forwards parameter changes, which the engine applies between two 1 ms cycles. Recordings are written by
the engine at the full rate.

## Safety layers (all in the engine)
- Forces are **off** until the student in control switches them on; they need a calibrated device.
- Forces **fade in** over 1 s; `|F|` is clamped to the page's limit (hard cap 4 N); `k ≤ 1000 N/m`, `b ≤ 15 N·s/m`;
  the target point moves at most 0.1 m/s and `k`, `b` change gradually, so a slider never makes the handle jump.
- **Watchdog:** the server sends a heartbeat only while the controlling page is alive. If the page closes, crashes or
  goes to the background, forces are off within 2 s (usually about 1 s).
- **Speed guard:** forces switch off if the cursor moves faster than 1.5 m/s (instability shows up as speed first).
- **One driver at a time** (control lock); everybody else can watch.
- **Physical interlock:** forces need the motor power cable. Without it the device still streams its position.

## Install on the lab Pi (once)
```bash
cd ~/myHAPLY-PyBULLET && git pull
bash lab/setup_pi.sh
```
It builds everything, creates the user `student` (no password, no sudo, only group `dialout`), installs the services
`haply-lab` (port 8780) and `haply-term`, and prints the link with the lab key, e.g.
`http://10.163.27.42:8780/?key=…`. The key lives in `~/.config/haply-lab/key`; delete it and restart to change it.

Useful commands:
```bash
systemctl status haply-lab haply-term
journalctl -u haply-lab -f                 # engine + server log
sudo systemctl restart haply-lab           # after a git pull that changed the engine: rebuild first (cmake --build build)
cat ~/haply-lab/feedback/feedback.jsonl    # what students sent
ls ~/haply-lab/data/                       # recordings
```

## Run it anywhere else
```bash
python3 lab/haply_lab.py            # with a device
python3 lab/haply_lab.py --sim      # simulator, no device (works on Windows too; no terminal there)
```
The same page is published on GitHub Pages (<https://harshaturlapati.github.io/myHAPLY-PyBULLET/>) where, with no
server behind it, it runs its own JavaScript simulator: students can learn and practise at home.

## Files
| file | what it is |
|---|---|
| `engine/haply_lab_engine.cpp` | real-time engine: device, equations (`libs/myHAPLY_SCENARIOS.h`), safety, recording |
| `haply_lab.py` | web server: page, live stream, control lock, recordings, source browser, feedback, LabTV |
| `haply_term.py` | WebSocket ⇄ pseudo-terminal for the Terminal tab |
| `systemd/*.service`, `setup_pi.sh` | install on the Pi |
| `../docs/` | the page itself (`index.html`, `app.js`, `app.css`), lessons (`learn/`), browser libraries (`vendor/`) |
