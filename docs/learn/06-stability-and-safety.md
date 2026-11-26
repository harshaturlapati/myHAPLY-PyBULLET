# Stability and safety

**You will learn:**
- why a stiff virtual wall buzzes, and why stiffness cannot grow forever
- why the forces fade in over 1 s instead of switching on at once
- every safety layer of the lab engine, and the message the page shows when one trips

**Time:** 25 min

## 1. Why stiff walls buzz

The engine looks at your hand once every $T = 1$ ms and keeps the force constant until the next look.
That small delay is enough to make a spring **create** energy.

1. **Going in.** The force is computed from where you were 1 ms ago, slightly **shallower**. It is a bit too small,
   so the spring stores a bit **less** energy than it should.
2. **Coming out.** The force is computed from where you were 1 ms ago, slightly **deeper**. It is a bit too large,
   so the spring gives back a bit **more** energy than it should.
3. Every bounce adds a little energy. If friction and your hand do not remove it, the bounces grow: **buzz**.

How big is the error? Enter a wall of $k = 1000$ N/m at $0.1$ m/s. In one sample you move $0.1 \times 0.001 = 0.1$ mm,
so the force lags by up to $1000 \times 0.0001 = 0.1$ N. Double $k$ and the lag doubles.

A classic rule (Colgate and Schenkel, 1997) says a sampled virtual wall never creates energy if the device's own
friction $b_{\text{device}}$ is large enough:

$$
b_{\text{device}} > \frac{k\,T}{2} + \lvert b \rvert
$$

With $T = 0.001$ s and $k = 1000$ N/m, the device needs $b_{\text{device}} > 0.5$ N s/m. At 100 Hz ($T = 0.01$ s) it
would need 5 N s/m, ten times more. That is what the 1 kHz loop buys you. It also shows why **stiffness cannot grow
forever**: at some $k$, the device's friction is no longer enough.

**What about damping?** In practice a little virtual damping $b$ calms the buzz, because it soaks up the energy
of your hand bouncing on the wall. But $b$ is computed from a sampled velocity too, which is why it appears on the
"cost" side of the rule: too much $b$ buzzes as well. Look for the sweet spot, usually a few N s/m.
Your grip helps too: a firm hand adds real damping.

- [▶ Try it: stiff wall, little damping](#try=wall&k=800&b=0.5&xd=here&rpy=0,0,0)
- [▶ Try it: stiff wall, some damping](#try=wall&k=800&b=3&xd=here&rpy=0,0,0)
- [▶ Try it: stiff wall, a lot of damping](#try=wall&k=800&b=10&xd=here&rpy=0,0,0)

## 2. Why forces fade in

Imagine switching on a $k = 300$ N/m spring while your hand is 2 cm from the target. The equation asks for 6 N,
capped to 2 N, and it would arrive within one millisecond: a kick. So the engine first caps the force at `fmax`,
then multiplies it by a **ramp** that grows from 0 to 1 over 1 s:

$$
\mathbf{F} = r\,\operatorname{cap}\left(\mathbf{F}_{\text{eq}}\right), \qquad
\operatorname{cap}(\mathbf{F}) = \mathbf{F}\,\min\left(1,\ \frac{f_{\max}}{\lVert \mathbf{F} \rVert}\right), \qquad
r \leftarrow \min\left(1,\ r + \frac{T}{1\ \text{s}}\right)
$$

Each cycle adds $0.001$, so after 1000 cycles (1 s) you have the full force. The order matters: capping first means
the force grows smoothly from 0 to at most `fmax` over the whole second, however large $\mathbf{F}_{\text{eq}}$ is.
(The other way round, $r\,\mathbf{F}_{\text{eq}}$ with 6 N asked would hit the 2 N cap after a third of a second.)
The ramp restarts from 0 when you switch forces on, change the scenario, change a custom equation, or make one big
jump in $k$ or $b$ (more than 100 N/m or 3 N·s/m at once, such as switching from "Damping field" to "Spring");
dragging a slider changes them in small steps and does not restart it. In `lab/engine/haply_lab_engine.cpp`:

```cpp
            ramp_ = std::min(1.0, ramp_ + dt / RAMP_TIME);
            F = F_eq;
            if (!F.allFinite()) F.setZero();
            const double n = F.norm();
            if (n > fmax_) F *= fmax_ / n;    // first cap the size (the direction stays the same) ...
            F *= ramp_;                       // ... then fade in: full force only after RAMP_TIME, however large F_eq
```

The same block also throws away a force that is not a finite number, and caps $\lVert \mathbf{F} \rVert$ at `fmax`
by scaling the whole vector (so its direction is kept). `fmax` itself may drop at once but rises by at most 2 N per
second, so dragging the force-limit slider up never steps the force either.

## 3. The limits, in one place

All the numbers sit at the top of the engine:

```cpp
constexpr double K_MAX = 1000.0, B_MAX = 15.0, FMAX_HARD = 4.0, V_GUARD = 1.5;
constexpr double XD_RATE = 0.10;        // m/s       how fast the target point may move
constexpr double K_RATE = 2000.0;       // N/m/s     how fast stiffness may change
constexpr double B_RATE = 30.0;         // N s/m/s
constexpr double RPY_RATE = 1.0;        // rad/s
constexpr double RAMP_TIME = 1.0;       // s         forces fade in over this time
constexpr double HB_TIMEOUT = 1.0;      // s
```

## 4. Every safety layer, and what the page says

1. **Forces start off.** Nothing pushes until you switch forces on. The page says `forces ON (fading in over 1 s)`.
2. **Calibration.** No calibration, no forces. You see `cannot switch forces on: the device is not calibrated`,
   or, if it happens while forces are on, `forces off: the device is not calibrated`. Fix: dock the cursor (lesson 00).
3. **Heartbeat watchdog.** While the page you drive from is alive, the lab server sends the engine a heartbeat
   5 times a second. If the engine hears nothing for 1 s, it switches forces off: `forces off: the page stopped answering (watchdog)`.
   Counting the server's own grace period, forces are off at most 2 s after the page stops (usually about 1 s).
   Before switching on you may see `cannot switch forces on: no heartbeat from the page`. Fix: reload the page, take control again.
4. **Speed guard.** If $\lVert \mathbf{v} \rVert > 1.5$ m/s, forces switch off, because an unstable spring usually shows up as speed first.
   The message reads like `forces off: speed guard, |v| = 1.62 m/s (limit 1.5). Lower k or raise b.` Do what it says.
5. **Fade-in.** Section 2.
6. **Parameter limits.** $k \le 1000$ N/m and $b \le 15$ N s/m on each axis, `fmax` $\le 4$ N, and the target point within
   $\pm 0.3$ m on each axis. Larger values are quietly cut to the limit.
7. **Smooth changes.** The target point moves at most 0.1 m/s, $k$ changes at most 2000 N/m per second, $b$ at most 30 N s/m
   per second, and the angles at most 1 rad/s. Dragging a slider never produces a jump.
8. **Force cap.** $\lVert \mathbf{F} \rVert \le$ `fmax` (section 2), and non-finite forces become zero.
9. **Second cap in the device class.** `render_F_cmd()` in `libs/myHAPLY_v1.h` caps $\lVert \mathbf{F} \rVert$ again, at `F_max`.
   Simple programs such as `01_read_fbk` keep the default of 3 N; the lab engine raises it to its own hard limit of 4 N,
   so that the engine's `fmax` is the one that counts and the force it logs is the force the device receives:

```cpp
    float F_max = 3.0f;                     // safety clamp on |F| (N); raise deliberately, not by accident
```

```cpp
        haply_.F_max = (float)FMAX_HARD;   // the engine's own clamp (fmax <= 4 N) is the one that counts
```

10. **Lost device.** After more than 50 failed exchanges in a row the engine drops the connection, switches forces off and
    retries: `lost the Inverse3 (timeout); retrying` (the reason in brackets may differ).
11. **One driver.** Only the person in control can send commands; releasing control switches forces off.
12. **Clean exit.** When the engine stops, `quick_stop()` sends zero force before closing the port. If the lab server
    itself goes silent (when the engine runs with `--parent-timeout`), the engine stops on its own.

The speed guard, the watchdog and the calibration check are three lines in a row in `lab/engine/haply_lab_engine.cpp`:

```cpp
            if (!calibrated_) { forces_ = false; set_msg("forces off: the device is not calibrated"); }
            else if (t - last_hb_ > HB_TIMEOUT) { forces_ = false; set_msg("forces off: the page stopped answering (watchdog)"); }
            else if (v_.norm() > V_GUARD) {
```

Notice what is **not** in the list: the equations in `libs/myHAPLY_SCENARIOS.h` contain no safety code at all.
Safety lives in one file, so every scenario, including yours, gets all of it.

## Check yourself

1. Open the three stiff walls of section 1 and tap each one. Which buzzes? Which feels "dead"? Which $b$ would you pick?
2. Hold the handle 2 cm from a $k = 300$ N/m spring target and switch forces on. How long until the force stops growing? What value does it settle at, and why not 6 N?
3. While driving with forces on (hold the handle), close your browser tab. Which message appears when you reopen the page? About how long did it take?
4. Look at your fastest free-motion recording from lesson 01. How close did you get to the 1.5 m/s speed guard?
5. Suppose `fmax` is set to 4 N and a spring asks for 3.5 N. What force reaches the device from the lab engine? And from a program that uses `myHAPLY` with its default `F_max`? Which lines decide?
