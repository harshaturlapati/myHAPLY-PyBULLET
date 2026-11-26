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

## Safety layers
In the engine:
- Forces are **off** until the student in control switches them on, and they only go on with a calibrated device
  that is connected (not released) and a live page. A disconnect or a release switches them off at once.
- Forces **fade in** over 1 s; `|F|` is clamped to the page's limit (hard cap 4 N), which drops at once but rises at
  most 2 N/s; `k ≤ 1000 N/m`, `b ≤ 15 N·s/m`; the target point moves at most 0.1 m/s and `k`, `b` change gradually,
  so a slider never makes the handle jump.
- **Watchdog:** the server sends a heartbeat only while the controlling page is alive. If the page closes, crashes or
  goes to the background, forces are off within 2 s (usually about 1 s).
- **Speed guard:** forces switch off if the cursor moves faster than 1.5 m/s (instability shows up as speed first).
- **Clean stop:** on `systemctl stop`/`restart`, a shutdown, Ctrl+C, or a crash of the web server, the engine switches
  forces off, sends a zero-force frame, closes the port and finishes the recording it was writing.

Around it:
- **One driver at a time** (control lock); everybody else can watch, and **everybody can press Stop forces**, also
  with the view-only link. The server log says who pressed it.
- **Server watchdog:** if the engine stops reporting for 3 s, the server kills it and starts a new one.
- **Physical interlock:** forces need the motor power cable. Without it the device still streams its position.

## Keys, token and the student sandbox
- **Lab key** (`~/.config/haply-lab/key`): in the link students get. Watch, take control, record, Terminal tab.
- **View key** (`~/.config/haply-lab/viewkey`): read-only. Watch, list recordings, read the code, press Stop forces;
  it never gets control. The lab TV uses it, and only lab-key holders are shown it.
  To change a key, delete its file and run `sudo systemctl restart haply-lab haply-term`. Both files are private to
  the admin (0600, in a 0700 folder).
- **UDP token:** the server and the engine talk over UDP on 127.0.0.1, which every program on the Pi can reach,
  including the students' shells. So every datagram starts with a random token that the server makes at each start
  and gives the engine in the environment variable `HAPLY_LAB_TOKEN` (never on the command line, which other users
  can read). Without it, a script in the Terminal tab could send `hb` and `forces 1` straight to the engine and skip
  the key, the control lock and the watchdog, or feed the server a fake state. Datagrams without the token are
  dropped; the engine counts the ones it drops (`auth_drops`).
  An engine started by hand without the variable runs in open developer mode (`"auth": false`, with a warning).
- **Student sandbox** (`systemd/haply-term.service`): the Terminal tab's shells run as `student` (no password, no
  sudo, only group `dialout`), with no CAN sockets (the robot arms), no new privileges, a read-only system, and
  other users' processes hidden. **No SSH:** a locked password does not stop SSH key logins, so
  `/etc/ssh/sshd_config.d/haply-student.conf` says `DenyUsers student`.
- **Memory:** student processes together are slowed down above 700 MB and the biggest one is killed at 900 MB
  (build with `-j2`). If the Pi still runs out, the kernel kills student processes first and the lab last
  (`OOMScoreAdjust` +500 / -500). Raspberry Pi kernels may need `cgroup_enable=memory` in `cmdline.txt` for this:
  `setup_pi.sh` adds it and asks for one reboot.

## Install on the lab Pi
```bash
cd ~/myHAPLY-PyBULLET && git pull
bash lab/setup_pi.sh            # as the lab admin account (with sudo), not as root
```
It builds everything, creates the user `student`, installs and (re)starts the services `haply-lab` (port 8780) and
`haply-term`, and prints two links: the **lab link** for students, e.g. `http://10.163.27.42:8780/?key=…`, and the
**view-only link** for the lab TV or a projector (`…/?key=<view key>&view=tv`). Run it again after every `git pull`:
it rebuilds and restarts both services, which switches forces off and ends every terminal session (not during a class).

Useful commands:
```bash
systemctl status haply-lab haply-term
journalctl -u haply-lab -f                 # engine + server log
sudo systemctl restart haply-lab           # restart server + engine (forces off, zero force, recording saved)
sudo systemctl restart haply-term          # end of class: ends every student shell and what students left running
cat ~/haply-lab/feedback/feedback.jsonl    # what students sent
ls ~/haply-lab/data/                       # recordings
df -h ~; sudo du -sh /home/student         # free space, and what students use of it (they share the SD card)
```
On a stop or restart, systemd sends SIGTERM to the server and the engine; the server also sends `forces 0` and `quit`
and waits for the engine: up to 3 s, or up to 20 s while it still reports because it is saving a recording
(forces are already off then). Anything still running 25 s later is killed (`TimeoutStopSec=25`).

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
