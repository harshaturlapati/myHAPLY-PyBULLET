# Your own equation: the Equation lab

**You will learn:**
- which variables and functions you may type, and what units they carry
- six worked equations and what each one feels like
- how your text becomes a force inside the 1 kHz loop, and how it compares with the built-in C++
- how to propose your equation as a new built-in scenario

**Time:** 35 min

## 1. What you type

You type three expressions, $F_x$, $F_y$ and $F_z$, in **newtons**, in the **device frame** (roll, pitch and yaw are
not applied to custom equations). The engine evaluates all three every millisecond with the newest position and velocity.
All the safety layers of lesson 06 still apply: fade-in, `fmax`, speed guard, watchdog.

## 2. The grammar

From the top of `libs/myEXPR.h`:

```cpp
// Grammar:  numbers, + - * / ^, parentheses, the variables listed in VAR_NAMES, the constant pi, and
//           sin cos tan asin acos atan exp log sqrt abs sign step floor   (one argument)
//           min max atan2 pow                                           (two arguments)
//           clamp(value, lo, hi)                                        (three arguments)
// step(a) is 1 when a > 0, else 0: handy for one-sided forces such as walls.
```

The variables, in the order the engine fills them:

```cpp
        static const char* const names[N_VARS] = {"x", "y", "z", "vx", "vy", "vz", "t", "xd", "yd", "zd",
                                                  "kx", "ky", "kz", "bx", "by", "bz"};
```

| Variables | Meaning | Unit |
|---|---|---|
| `x y z` | cursor position | m |
| `vx vy vz` | cursor velocity | m/s |
| `t` | time since the engine started | s |
| `xd yd zd` | target point (set with `xd`, for example "here") | m |
| `kx ky kz` | the stiffness you set with $k$ | N/m |
| `bx by bz` | the damping you set with $b$ | N s/m |

Rules that catch people out:

1. Type only the right-hand side in each box (no `fx =`). Names are **case sensitive**. `X + 1` gives the error `unknown name 'X' at position 1`.
2. There is no `if` and no `<`. Use `step(a)`, which is 1 when $a > 0$ and 0 otherwise.
3. Write `*` for every product: `2*pi*t`, not `2pi t`.
4. `-x^2` means $-(x^2)$, and `2^3^2` means $2^{(3^2)} = 512$.
5. Type `0` for "no force on this axis". Keep each equation under 240 characters.

## 3. Six worked examples

**Example 1: a spring on one axis.** $F_x = -k_x(x - x_d) - b_x v_x$, $F_y = F_z = 0$.

In the $F_x$ box type `-kx*(x - xd) - bx*vx` (and `0` in the other two). With $k = 300$ N/m, moving 5 mm along x gives 1.5 N; moving along y or z is free.
You have built a **plane guide** by hand: free in the y-z plane, pulled onto the plane $x = x_d$.

[▶ Try it: spring on x only](#try=custom&k=300&b=2&xd=here&fx=-kx%2A%28x%20-%20xd%29%20-%20bx%2Avx&fy=0&fz=0)

**Example 2: an anisotropic spring.** $F_x = -100\,(x - x_d) - b_x v_x$, $F_y = -500\,(y - y_d) - b_y v_y$, $F_z = 0$.

Numbers replace `kx` and `ky`, so each axis has its own stiffness. 3 mm along x gives 0.3 N; 3 mm along y gives 1.5 N.
It feels like an oval bowl: soft one way, stiff the other.

[▶ Try it: soft in x, stiff in y](#try=custom&k=300&b=2&xd=here&fx=-100%2A%28x%20-%20xd%29%20-%20bx%2Avx&fy=-500%2A%28y%20-%20yd%29%20-%20by%2Avy&fz=0)

**Example 3: viscous damping.** $\mathbf{F} = -b\,\mathbf{v}$ on every axis. Type `-bx*vx`, `-by*vy` and `-bz*vz` in the three boxes.

With $b = 5$ N s/m, moving at 0.2 m/s gives 1 N against you. Hold still and the force is zero.

[▶ Try it: honey everywhere](#try=custom&b=5&fx=-bx%2Avx&fy=-by%2Avy&fz=-bz%2Avz)

**Example 4: a wall with `step()`.** $F_z = \max\left(0,\ k_z(z_d - z) - b_z v_z\right)\cdot \operatorname{step}(z_d - z)$.

In the $F_z$ box type `max(0, kz*(zd - z) - bz*vz)*step(zd - z)`. `step(zd - z)` is 1 only when you are below $z_d$, inside the wall.
`max(0, ...)` stops it from pulling you in. This is the built-in wall of lesson 05 with rpy = 0, written by you.
With $k = 500$ N/m, 4 mm inside gives 2 N.

[▶ Try it: a +z wall written with step()](#try=custom&k=500&b=3&xd=here&fx=0&fy=0&fz=max%280%2C%20kz%2A%28zd%20-%20z%29%20-%20bz%2Avz%29%2Astep%28zd%20-%20z%29)

**Example 5: a magnet.** It pulls towards $\mathbf{x}_d$, harder as you come closer, but is clamped:

$$
\mathbf{F} = \operatorname{clamp}\left(\frac{0.04\,(\mathbf{x}_d - \mathbf{x})}{\lVert \mathbf{x} - \mathbf{x}_d \rVert^2 + 0.0001},\ -1.5,\ 1.5\right) - b\,\mathbf{v}
$$

In the $F_x$ box type `clamp(0.04*(xd - x)/((x-xd)^2 + (y-yd)^2 + (z-zd)^2 + 0.0001), -1.5, 1.5) - bx*vx`, and the same with `yd - y`, `zd - z`.

| distance from $\mathbf{x}_d$ | 10 cm | 5 cm | 2 cm | 1 cm | 2 mm | 0 |
|---|---|---|---|---|---|---|
| force (N) | 0.40 | 0.77 | 1.5 (clamped, 1.6) | 1.5 (clamped, 2.0) | 0.77 | 0 |

The `+ 0.0001` (that is $(1\ \text{cm})^2$) avoids dividing by zero and turns the centre into a gentle 400 N/m spring.
The `clamp` caps each axis at 1.5 N.

[▶ Try it: magnet at your hand](#try=custom&b=2&xd=here&fx=clamp%280.04%2A%28xd%20-%20x%29%2F%28%28x-xd%29%5E2%20%2B%20%28y-yd%29%5E2%20%2B%20%28z-zd%29%5E2%20%2B%200.0001%29%2C%20-1.5%2C%201.5%29%20-%20bx%2Avx&fy=clamp%280.04%2A%28yd%20-%20y%29%2F%28%28x-xd%29%5E2%20%2B%20%28y-yd%29%5E2%20%2B%20%28z-zd%29%5E2%20%2B%200.0001%29%2C%20-1.5%2C%201.5%29%20-%20by%2Avy&fz=clamp%280.04%2A%28zd%20-%20z%29%2F%28%28x-xd%29%5E2%20%2B%20%28y-yd%29%5E2%20%2B%20%28z-zd%29%5E2%20%2B%200.0001%29%2C%20-1.5%2C%201.5%29%20-%20bz%2Avz)

**Example 6: a vibration.** $F_z = 0.3 \sin(2\pi \cdot 5 \cdot t)$. In the $F_z$ box type `0.3*sin(2*pi*5*t)`.

The handle shakes up and down 5 times per second with 0.3 N amplitude. Change the 5 to 20, then 50: it turns from a
wobble into a buzz. Keep the amplitude at 0.5 N or less.

[▶ Try it: 5 Hz vibration](#try=custom&fx=0&fy=0&fz=0.3%2Asin%282%2Api%2A5%2At%29)

## 4. How your text becomes a force

The page sends your text to the engine, which **compiles** it once into a short stack program
(`Expr::compile` in `libs/myEXPR.h`). Errors come back with a position, like `missing ')' after the arguments of 'sin' at position 6`.
Then every millisecond the scenario code fills the variables and **evaluates** the three programs. In `libs/myHAPLY_SCENARIOS.h`:

```cpp
        case Kind::Custom: {
            double vars[my::Expr::N_VARS] = {x.x(), x.y(), x.z(), v.x(), v.y(), v.z(), t,
                                             s.x_d.x(), s.x_d.y(), s.x_d.z(),
                                             s.k.x(), s.k.y(), s.k.z(), s.b.x(), s.b.y(), s.b.z()};
            return Vec3(s.fx.eval(vars), s.fy.eval(vars), s.fz.eval(vars));
        }
```

Evaluating takes well under a microsecond and never allocates memory. If your equation divides by zero, the result
is not finite and the engine replaces the whole force by zero (lesson 06).

## 5. The same equation in C++ with Eigen

Examples 1 to 4 already exist as built-in C++. Compare what you typed with these lines of `libs/myHAPLY_SCENARIOS.h`.
Examples 1, 2 and 3 are the impedance line with different $\mathbf{K}$ and $\mathbf{B}$:

```cpp
            const Vec3 f_local = s.k.asDiagonal() * e - s.b.asDiagonal() * u;   // K e - B u
```

Example 4 is the wall:

```cpp
            const double push = std::max(0.0, s.k.z() * d - s.b.z() * u.z());
```

The built-in versions are faster to read, work in any rotated frame, and are checked by the compiler. A sketch of
how the magnet could look as a built-in case (this code is **not** in the repository; it is only a starting point):

```text
const Vec3 r = s.x_d - x;
const Vec3 f = 0.04 * r / (r.squaredNorm() + 0.0001);
return f.cwiseMax(Vec3::Constant(-1.5)).cwiseMin(Vec3::Constant(1.5)) - s.b.asDiagonal() * v;
```

## 6. Propose a new built-in scenario

Found an equation that is useful or fun? Open a GitHub issue titled **"Equation proposal: magnet"** (with your own name for it) at
<https://github.com/harshaturlapati/myHAPLY-PyBULLET/issues/new?title=Equation%20proposal%3A%20> and include:

1. the equation in LaTeX, and the three expressions exactly as you typed them,
2. the parameters ($k$, $b$, `fmax`) and what it feels like, in one or two sentences,
3. a recording (CSV file name and a plot) that shows it working,
4. the largest force and the steepest slope (N/m) it can produce. Keep the slope under 1000 N/m.

No GitHub account? Send the same text through the Feedback tab.

## Check yourself

1. Type example 1 and push 5 mm along x. Does the page show 1.5 N? Which built-in preset and rpy give the same feel?
2. In example 2, push 3 mm along x, then 3 mm along y. Do you get 0.3 N and 1.5 N?
3. In the magnet, move slowly from 10 cm to 0 cm. Where is the pull strongest? Does that match the table?
4. Rewrite example 4 so that the wall faces $-z$ (it pushes you towards $-z$). Hint: swap `zd - z` for `z - zd`, then check the sign of the damping term and of the whole force. Test it.
5. Write a second wall in $F_x$ (same pattern as example 4) so that you are boxed in on two sides. Test it.
