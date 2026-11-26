# Frames, units and the 1 kHz loop

**You will learn:**
- the three quantities of the lab and their SI units: position (m), velocity (m/s), force (N)
- which way the axes of the device frame point (you will find out yourself)
- what happens in one 1 ms cycle, and how `01_read_fbk.cpp` reads the device
- what every column of a recording CSV means

**Time:** 20 min

## 1. Three quantities, three units

The code always works in SI units. The page sometimes shows millimetres to make numbers friendlier.

| Symbol | Meaning | Unit | Typical value in the lab |
|---|---|---|---|
| $\mathbf{x} = (x, y, z)$ | cursor position | m | a few centimetres: $0.02$ m $= 20$ mm |
| $\mathbf{v} = (v_x, v_y, v_z)$ | cursor velocity | m/s | a calm hand moves at $0.05$ to $0.3$ m/s |
| $\mathbf{F} = (F_x, F_y, F_z)$ | force on your hand | N | $0$ to $4$ N |

Two conversions you will use all the time:

$$
1\ \text{mm} = 0.001\ \text{m}, \qquad 1\ \text{N/m} \times 1\ \text{cm} = 0.01\ \text{N}
$$

So a spring of $k = 300$ N/m stretched by $5$ mm pushes with $300 \times 0.005 = 1.5$ N.

## 2. The device frame

All positions, velocities and forces are written in the **device frame**: a set of x, y, z axes fixed to
the base of the Inverse3. The header of `libs/myHAPLY_v1.h` says so:

```cpp
// Frames and units: X (m) and V (m/s) are the cursor position/velocity in the device frame.
```

Find the axes yourself. It takes two minutes and you will need them in every lesson.

1. Open free motion (no forces): [▶ Try it: free motion](#try=free)
2. Move the handle **to your right**. Which of $x, y, z$ grows? Write it down.
3. Move it **away from you**. Which one grows?
4. Move it **up**. Which one grows?
5. Check with your right hand: thumb along $+x$, index finger along $+y$, middle finger along $+z$.
   If your fingers agree with what you wrote down, the frame is right-handed (it should be).

## 3. One cycle, one millisecond

The lab engine (`lab/engine/haply_lab_engine.cpp`) runs this loop 1000 times per second:

1. read $\mathbf{x}, \mathbf{v}$ from the device,
2. compute $\mathbf{F}$ from the scenario equation,
3. send $\mathbf{F}$ to the device,
4. sleep until the next millisecond.

The header of the engine says it in one line:

```cpp
// Owns the Inverse3 and runs the haptic loop at 1 kHz:  read x, v  ->  F = scenario equation  ->  send F.
```

and this is the "sleep until the next tick" part:

```cpp
            // 5. wait for the next tick
            t_next += period;
            if (t_next < my::Clock::now() - 5 * period) t_next = my::Clock::now();   // fell far behind: resync
            if (sim || connected_) my::sleep_until(t_next);
```

**What does 1 ms buy you?** Suppose your hand moves at $0.2$ m/s into a spring of $k = 500$ N/m.

- In 1 ms your hand moves $0.2 \times 0.001 = 0.0002$ m $= 0.2$ mm.
- The force changes by $500 \times 0.0002 = 0.1$ N per cycle. That feels smooth.
- A screen refreshes at 60 Hz (every 16.7 ms). In that time your hand moves 3.3 mm, so the force would jump by
  $1.7$ N at once. That feels like a buzz or a kick.

Touch needs about a thousand updates per second; vision needs only about 60. That is why haptics runs at 1 kHz.
One exchange with the device takes only about 0.15 ms, so most of each millisecond is spent waiting.

## 4. How `01_read_fbk.cpp` reads the device

`100-Haply-basics/01_read_fbk.cpp` is the simplest program in the repository. It never pushes on your hand.
It has three parts.

**Start.** Create the device object and call `quick_start()` (find the port, wake the device up, print 10 samples):

```cpp
    myHAPLY Haply("Inverse3", port);
    Haply.timeout_ms = (int)timeout_ms;
    if (!Haply.quick_start()) {   // always needs to be done
        return 1;
    }
```

**Loop.** Every cycle, send the force command. Here it is always zero, so this is a pure read:

```cpp
        // Query Haply state: F_cmd is zero in this example, so this is a pure feedback read.
        const bool ok = Haply.render_F_cmd();
```

Inside `render_F_cmd()` one message goes out and one comes back. The protocol, from `libs/myHAPLY_v1.h`:

```cpp
//   cursor force   host 0x2A + fx fy fz (N)       device 0x2B + x y z (m) + vx vy vz (m/s)        (25 bytes)
```

So you send 1 byte `0x2A` plus three 4-byte floats (13 bytes), and receive 1 byte `0x2B` plus six floats (25 bytes).
The six floats land in `X` and `V`:

```cpp
        for (int i = 0; i < 3; i++) { X[i] = rx[i]; V[i] = rx[3 + i]; }
```

**Stop.** Back in `100-Haply-basics/01_read_fbk.cpp`: leave the device with zero force, close the port, write the CSV:

```cpp
    Haply.quick_stop();
    Haply_LOG.write2FILE(Haply.name);
```

## 5. The CSV columns of a lab recording

When you record in the Experiment tab, the engine writes one row per millisecond. The first lines start with
`Robot NAME:` and `#`: they store the scenario and parameters (target `xd` in m, `rpy` in radians, `k`, `b`, `fmax`).
Then comes the header row, written by this line of `lab/engine/haply_lab_engine.cpp`:

```cpp
            f << "Time(ms),Time(s),Unix_epoch(ns),X,Y,Z,VX,VY,VZ,f1,f2,f3,e1,e2,e3,ramp,loop_us,Index\n";
```

| Column | Meaning | Unit |
|---|---|---|
| `Time(ms)`, `Time(s)` | time since the recording started | ms, s |
| `Unix_epoch(ns)` | wall-clock time, to line up with other data | ns |
| `X, Y, Z` | cursor position $\mathbf{x}$ | m |
| `VX, VY, VZ` | cursor velocity $\mathbf{v}$ | m/s |
| `f1, f2, f3` | force the engine sent, after fade-in and clamp | N |
| `e1, e2, e3` | error $\mathbf{x}_d - \mathbf{x}$ seen in the target frame (lesson 02) | m |
| `ramp` | fade-in factor, 0 when forces are off, 1 when fully on | none |
| `loop_us` | time of the device round trip (0 in the simulator) | µs |
| `Index` | row number, 0, 1, 2, ... | none |

`01_read_fbk.cpp` writes a similar file to `logs/` with the columns
`Time(ms), Time(s), Unix_epoch(ns), X, Y, Z, VX, VY, VZ, f1, f2, f3, UDP_f1..UDP_f6, loop_us, Index`.

## Check yourself

1. Record 5 s of free motion. Look at the `Time(ms)` column: by how much does it grow from one row to the next? How many rows do you get?
2. Move the handle 2 cm to the right. By how much does the matching column of `X, Y, Z` change? Is it $0.02$?
3. Move as fast as you comfortably can (forces off!). What is the largest speed in `VX, VY, VZ`? At that speed, how far do you travel in one 1 ms cycle?
4. What is the typical value in `loop_us`? What fraction of the 1 ms cycle is that?
5. With forces off, what does the `ramp` column contain? And `f1, f2, f3`?
