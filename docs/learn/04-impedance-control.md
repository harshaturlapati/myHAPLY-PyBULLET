# Impedance control: springs and dampers

**You will learn:**
- the spring law $F = k(x_d - x)$ and the damper law $F = -b\,v$, with numbers you can feel
- how the lab writes both in 3-D with diagonal matrices $\mathbf{K}$ and $\mathbf{B}$
- the exact lines of code that compute the force
- how to measure $k$ from your own recording

**Time:** 30 min

## 1. The spring

A spring pulls you towards its rest point $x_d$. The further you are, the harder it pulls:

$$
F = k\,(x_d - x)
$$

$k$ is the **stiffness** in N/m. Example: $k = 300$ N/m and you are 1 cm away, so $F = 300 \times 0.01 = 3$ N.

How the stiffness feels in the lab (with the default force cap `fmax` = 2 N):

| $k$ (N/m) | force at 1 cm | where it reaches 2 N | feels like |
|---|---|---|---|
| 100 | 1 N | 2 cm | a soft rubber band |
| 300 | 3 N (capped at 2 N) | 6.7 mm | a firm spring |
| 800 | 8 N (capped at 2 N) | 2.5 mm | almost a hard surface |

- [▶ Try it: soft spring, k = 100 N/m](#try=spring&k=100&b=1&xd=here)
- [▶ Try it: firm spring, k = 300 N/m](#try=spring&k=300&b=3&xd=here)
- [▶ Try it: stiff spring, k = 800 N/m](#try=spring&k=800&b=3&xd=here)

## 2. The damper

A damper resists **speed**, not distance. It always pushes against your motion:

$$
F = -b\,v
$$

$b$ is the **damping** in N s/m. At a calm $0.2$ m/s:

| $b$ (N s/m) | force at 0.2 m/s | feels like |
|---|---|---|
| 1 | 0.2 N | barely there |
| 3 | 0.6 N | stirring water |
| 8 | 1.6 N | moving through honey |

[▶ Try it: damping field, b = 8 N s/m](#try=damping&b=8)

## 3. Impedance = spring + damper

Put them together and you have the simplest **impedance controller**: the device behaves like a spring and a damper
between your hand and the target.

$$
F = k\,(x_d - x) - b\,v
$$

The damper is what stops a spring from bouncing: without it, a spring plus your hand's mass oscillates.

## 4. In 3-D: diagonal $\mathbf{K}$ and $\mathbf{B}$

In 3-D you can give each axis of the target frame its own stiffness and damping:

$$
\mathbf{K} = \operatorname{diag}(k_x, k_y, k_z), \qquad \mathbf{B} = \operatorname{diag}(b_x, b_y, b_z)
$$

The full lab equation (lessons 02 and 03 explain $\mathbf{R}$):

$$
\mathbf{F} = \mathbf{R}\left(\mathbf{K}\,\mathbf{R}^\top(\mathbf{x}_d - \mathbf{x}) - \mathbf{B}\,\mathbf{R}^\top\mathbf{v}\right)
$$

With no rotation ($\mathbf{R} = \mathbf{I}$) it is just three 1-D springs and dampers side by side:
$F_x = k_x(x_d - x) - b_x v_x$, and the same for $y$ and $z$.

## 5. The code, line by line

All of it is in `libs/myHAPLY_SCENARIOS.h`, inside the function `force()`. Step 1, look from the target frame:

$$
\mathbf{e} = \mathbf{R}^\top(\mathbf{x}_d - \mathbf{x}), \qquad \mathbf{u} = \mathbf{R}^\top\mathbf{v}
$$

```cpp
    const Mat3 R = R_from_rpy(s.rpy);
    const Vec3 e = R.transpose() * (s.x_d - x);     // position error, target frame
    const Vec3 u = R.transpose() * v;               // velocity, target frame
```

Step 2, spring minus damper, then back to the device frame:

$$
\mathbf{f}_{\text{local}} = \mathbf{K}\mathbf{e} - \mathbf{B}\mathbf{u}, \qquad \mathbf{F} = \mathbf{R}\,\mathbf{f}_{\text{local}}
$$

```cpp
        case Kind::Impedance: {
            const Vec3 f_local = s.k.asDiagonal() * e - s.b.asDiagonal() * u;   // K e - B u
            return R * f_local;                                                 // back to the device frame
        }
```

`s.k` holds $(k_x, k_y, k_z)$ and `.asDiagonal()` turns it into $\operatorname{diag}(k_x, k_y, k_z)$. One line of code, one line of maths.

The engine (`lab/engine/haply_lab_engine.cpp`) calls this function every millisecond with the newest $\mathbf{x}$ and $\mathbf{v}$:

```cpp
        const Vec3 F_eq = haptics::force(scn_, x_, v_, t, &det);
```

Then it fades the force in and caps it (lesson 06) before sending it to the device.

## 6. Measure $k$ from your data

You will check that the device really renders $k = 300$ N/m.

1. Calibrate, take control, and hold the handle.
2. Open the spring at your hand: [▶ Try it: spring for measuring k](#try=spring&k=300&b=1&xd=here)
3. Switch forces on and **wait 2 s** (the force fades in over 1 s, and $k$ itself ramps up at 2000 N/m per second).
4. Start a recording in the Experiment tab. Label it `k300`.
5. Push **slowly** along $+x$ by about 5 mm, come back, then along $-x$ by 5 mm. Repeat 3 times. Stay under 6 mm so you never hit `fmax`.
6. Stop the recording and download the CSV.
7. Keep only rows with `ramp` = 1. Plot `f1` (vertical axis) against `e1` (horizontal axis).
8. Fit a straight line. Its **slope is $k$**, because $f_1 = k\,e_1 - b\,v_x \approx k\,e_1$ when you move slowly.

In a spreadsheet: a scatter chart plus a linear trendline. In Python:

```python
import numpy as np, pandas as pd
path = "k300.csv"                      # your file name
lines = open(path).read().splitlines()
start = next(i for i, l in enumerate(lines) if l.startswith("Time(ms)"))
d = pd.read_csv(path, skiprows=start)
d = d[d.ramp == 1]
k, c = np.polyfit(d.e1, d.f1, 1)
print("measured k =", round(k), "N/m")
```

You should get close to 300 N/m. If the points form a thin loop instead of a line, you moved too fast: the loop is $b\,v_x$.

## Check yourself

1. Set $k = 300$ N/m and push 5 mm away from the target. What force does the page show? Does it match $300 \times 0.005 = 1.5$ N?
2. Now push 1 cm. Does the force reach 3 N? If not, what number does it stop at, and which setting is that?
3. With the damping field at $b = 8$ N s/m, move at about 0.2 m/s. Is the force near 1.6 N? Which way does it point compared with your motion?
4. In your `k300` recording, what slope did you measure? By what percentage does it differ from 300?
5. Why does the code compute the damper with `u` and not with `v`? (Hint: which frame is $\mathbf{B}$ written in?)
