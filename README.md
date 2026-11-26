# myHAPLY-PyBULLET
Integrating the **Haply Inverse3** with **PyBullet** in C++, on **Windows** and **Raspberry Pi** (and other Linux).

Sibling of [myVIRTUOSE-PyBULLET](https://github.com/harshaturlapati/myVIRTUOSE-PyBULLET): same layout, same
"one numbered `.cpp` = one executable" convention, same device-object style (`quick_start()`, `getPOS()`,
`render_F_cmd()`, `quick_stop()`), but every line builds on both operating systems.

**Haply lab console:** a web page to play with the device, learn the equations of haptic interaction, record and
analyse experiments, read the C++ that runs it, write a report, and send feedback, without coding first.
- In the lab: served by the Pi at `http://<pi>:8780/?key=…` (live device, terminal, lab TV). See [`lab/README.md`](lab/README.md).
- Anywhere: <https://harshaturlapati.github.io/myHAPLY-PyBULLET/> runs the same page with a built-in simulator.

## How the code talks to the Haply
The Inverse3 is a USB serial device (CDC-ACM, USB id `16c0:0483`). [`libs/myHAPLY_v1.h`](libs/myHAPLY_v1.h)
speaks its binary protocol directly over the serial port: **one exchange sends a force (N) and returns the
cursor position (m) and velocity (m/s)**. There is no service, no WebSocket and no closed-source library in
between, so it is the quickest and most predictable way to sample the device and, later, to render forces.
It is plain C++17, so the same code builds on Windows, Linux, Raspberry Pi and macOS.

Measured on the lab Raspberry Pi 4 (Inverse3 firmware 7.10, motor power unplugged):

| loop | achieved rate | device round trip (mean / p99 / max) | errors |
|---|---|---|---|
| `--rate 1000` (default), 3 × 10 s | 997 – 1000 Hz | 150 µs / 340–610 µs / ≤ 2.1 ms | 0 |
| `--rate 0` (as fast as possible), 5 s | **7 894 Hz** | 126 µs / 179 µs / 1.6 ms | 0 |

Why not the alternatives Haply offers?

| | this repo: direct serial | Haply Inverse Service (WebSocket JSON) | Haply HardwareAPI 0.2.8 (legacy C++ lib) |
|---|---|---|---|
| Windows x64 | ✔ | ✔ | ✔ |
| Raspberry Pi OS 11 (aarch64) | ✔ | ✘ arm64 builds need Ubuntu 22.04+ | links only with a shim (built with GCC 12) |
| Firmware 7.10 status packets | skipped | handled by the service | **stalls ~1 s** each time one arrives before a reply |
| Extra software | none | service must run | closed-source download |

Protocol summary (little-endian float32; also documented at the top of `myHAPLY_v1.h`):
`0x0A` wake-up → `0x0B` id + UUID · `0x2A` force[3] → `0x2B` position[3] velocity[3] ·
`0x1A` joint torques[3] → `0x1B` joint angles[3] (deg) and velocities[3] · `0xBA type len payload` status events
from the device, at any time.

Only one program can open the device's port at a time. If Haply Hub or the Haply Inverse Service is running on
the same computer, close/stop it before running an example.

The legacy HardwareAPI can still be fetched for comparison with `-DMYHAPLY_WITH_HARDWAREAPI=ON`
([`cmake/HaplyHardwareAPI.cmake`](cmake/HaplyHardwareAPI.cmake) downloads it from Haply and checks its SHA-256;
it is closed source, so it is never stored in this repo). No example needs it.

## Layout
```
100-Haply-basics/01_read_fbk.cpp   read position + velocity, print, log to CSV   (one exe per numbered .cpp)
libs/myHAPLY_v1.h                  Inverse3 class: quick_start, getPOS, render_F_cmd, quick_stop (+ protocol)
libs/mySERIAL.h                    portable serial port + USB VID/PID lookup (Windows, Linux, macOS)
libs/myHAPLY_LOGGING.h             preallocated logger, CSV writer (like myVIRTUOSE_LOGGING.h)
libs/myINCLUDES.h                  portable includes, 1 kHz timing, press-Q-to-quit
libs/Eigen, libs/myGEOMETRY        linear algebra + rotation helpers (for the PyBullet examples)
src/                               Bullet shared-memory client -> library "pybullet_cpp"
libs/myHAPLY_SCENARIOS.h           the haptic equations (impedance, fixtures, wall, custom) written with Eigen
libs/myEXPR.h                      safe compiler for student-typed force equations
lab/                               lab console: real-time engine (C++), web server + terminal (Python), Pi setup
docs/                              the console web page (also GitHub Pages), lessons in docs/learn/
cmake/HaplyHardwareAPI.cmake       optional: Haply's legacy library (off by default)
scripts/build_windows.ps1          one-command build on Windows
```

## Build
### Windows 10/11 (x64)
1. Install **Visual Studio 2022 or newer** (Community is fine) with the workload **Desktop development with C++**
   (it includes CMake and Ninja).
2. Build everything:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\build_windows.ps1
   ```
   Or open the folder in Visual Studio (*File → Open → Folder*) and build from there.
3. Executables land in `build\`, e.g. `build\100-Haply-basics_01_read_fbk.exe`.

### Raspberry Pi OS / Debian / Ubuntu
```bash
sudo apt-get install --no-upgrade -y cmake g++ git
git clone https://github.com/harshaturlapati/myHAPLY-PyBULLET.git
cd myHAPLY-PyBULLET
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j4
```
Your user must be in the `dialout` group to open the serial port (`groups`; fix with
`sudo usermod -aG dialout $USER`, then log in again).

Optional, gives the device a fixed name `/dev/haply` that the examples try first
(`16c0:0483` is shared by every Teensy board, so add `ATTRS{serial}=="<your board serial>"` if you have several):
```
# /etc/udev/rules.d/70-haply.rules
SUBSYSTEM=="tty", ATTRS{idVendor}=="16c0", ATTRS{idProduct}=="0483", SYMLINK+="haply", ENV{ID_MM_DEVICE_IGNORE}="1"
```
then `sudo udevadm control --reload-rules && sudo udevadm trigger`.

## Run `01_read_fbk`
```
build/100-Haply-basics_01_read_fbk [--port COM5|/dev/haply] [--rate 1000] [--seconds 0] [--log-seconds 120] [--print-hz 20] [--timeout-ms 20]
```
- Finds the Inverse3 (or uses `--port`), wakes it up, prints its id, UUID and raw joint angles.
- **Calibrate first.** After every power-up the Inverse3 has no cursor position until it is calibrated: it reports
  `X = 0` and `V = 65535`, and the program prints `NOT CALIBRATED`. Front LED purple = needs calibration: rest the
  cursor on the magnetic dock until the LED changes colour, then lift it off.
- Streams position (m) and velocity (m/s) on one refreshing line. **Press Q** (or Ctrl+C) to stop.
- Read-only: the force sent every cycle is zero. Feedback works with only the USB cable; forces (later examples)
  also need the motor power supply.
- On exit it prints the achieved rate and the device round-trip time, and writes
  `logs/haply_log_file__Inverse3_<date>.csv` with columns
  `Time(ms), Time(s), Unix_epoch(ns), X, Y, Z, VX, VY, VZ, f1, f2, f3, UDP_f1..6, loop_us, Index`.
  Drop that file on the log viewer in `docs/index.html`.

## PyBullet (next examples)
`src/` builds the Bullet shared-memory client used by myVIRTUOSE-PyBULLET. Examples that use it need a PyBullet
server running on the same machine:
```
pip install pybullet
python -m pybullet_utils.runServer
```

## Handling the Inverse3 (from Haply's training session)
- Unplug the **motor power** cable whenever nobody is actively using the device; the drives otherwise stay energised.
- Don't leave the arm resting in the calibration dock; calibrate, then move it away.
- To stow it, fold the arms together (pinch) and pull back until it clicks; that locks the orientation.
- The stylus (VerseGrip) calibrates its orientation when it is switched on: put it down still in the orientation you
  want as "home". The device renders forces only, not torques.
- Every force example clamps `|F|` to `myHAPLY::F_max` (3 N by default). Keep a hand on the stylus when testing forces.

## Contributing
1. Fork this repo on GitHub, clone your fork, create a branch: `git checkout -b 02-my-example`.
2. Add your example as `NNN-Topic/NN_short_name.cpp`; CMake picks it up automatically (re-run CMake).
3. Build and run it on at least one OS; say which in the pull request.
4. Open a pull request against `harshaturlapati/myHAPLY-PyBULLET:main`.
Keep device-specific code in `libs/`, keep examples short, and never commit build folders, logs or Haply's binaries.

## Acknowledgements and licences
- Bullet shared-memory client from [erwincoumans/pybullet_cpp_sharedmemory_example](https://github.com/erwincoumans/pybullet_cpp_sharedmemory_example) (zlib licence).
- [Eigen](https://eigen.tuxfamily.org) (MPL 2.0).
- Haply HardwareAPI © Haply Robotics Inc., downloaded from Haply at build time, not redistributed here.
