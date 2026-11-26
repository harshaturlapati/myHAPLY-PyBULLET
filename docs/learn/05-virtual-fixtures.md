# Virtual fixtures: guides and walls

**You will learn:**
- how one impedance equation gives a line guide, a plane guide and a damping field, just by changing $\mathbf{K}$ and $\mathbf{B}$
- how roll, pitch and yaw point a guide in any direction
- why the wall is a **one-sided** spring, $F = \max(0, k d - b\,\mathbf{n}\cdot\mathbf{v})\,\mathbf{n}$
- how surgeons use the same ideas: guidance along a path, no-go zones

**Time:** 30 min

## 1. One equation, many behaviours

A **virtual fixture** is a force that helps you or stops you, like a ruler that guides a pencil. In the lab all
guides come from the impedance equation of lesson 04:

$$
\mathbf{F} = \mathbf{R}\left(\mathbf{K}\,\mathbf{R}^\top(\mathbf{x}_d - \mathbf{x}) - \mathbf{B}\,\mathbf{R}^\top\mathbf{v}\right)
$$

Only $\mathbf{K}$ and $\mathbf{B}$ change. The comment at the top of `libs/myHAPLY_SCENARIOS.h` lists them:

```cpp
//    One equation, many behaviours - only K and B change:
//        spring to a point   K = diag(k, k, k)      pulls x towards x_d along every direction
//        line guide          K = diag(k, k, 0)      free along the frame's z axis, pulled onto that line
//        plane guide         K = diag(0, 0, k)      free in the frame's x-y plane, pulled onto that plane
//        damping field       K = 0, B = diag(b,b,b) resists motion, like moving through honey
```

A zero on the diagonal means "no spring along that axis": you are free to move there.

## 2. The line guide: $\mathbf{K} = \operatorname{diag}(k, k, 0)$

1. Hold the handle and open the guide: [▶ Try it: line guide](#try=line&k=300&b=2&xd=here&rpy=0,0,0)
2. Switch forces on. Move along the device z axis: it should be free.
3. Move sideways by 5 mm: you feel $300 \times 0.005 = 1.5$ N pulling you back onto the line.

The line passes through $\mathbf{x}_d$ along $\mathbf{z}'$, the third column of $\mathbf{R}$.

## 3. The plane guide: $\mathbf{K} = \operatorname{diag}(0, 0, k)$

Now only the third axis has a spring. You can slide freely in the $x'$-$y'$ plane, like a pen on a table.

[▶ Try it: plane guide](#try=plane&k=300&b=2&xd=here&rpy=0,0,0)

## 4. The damping field: $\mathbf{K} = 0$, $\mathbf{B} = \operatorname{diag}(b, b, b)$

No springs at all, only dampers. Nothing pulls you anywhere; moving fast is just hard.
It is used to steady a shaky hand.

[▶ Try it: damping field](#try=damping&b=5)

## 5. Point the guide anywhere

Roll, pitch and yaw rotate the target frame, and the guide rotates with it (lesson 02).

- [▶ Try it: line guide, pitch 90° (along device x)](#try=line&k=300&b=2&xd=here&rpy=0,90,0)
- [▶ Try it: plane guide, roll 90° (normal along device -y)](#try=plane&k=300&b=2&xd=here&rpy=90,0,0)
- [▶ Try it: line guide, pitch 30° and yaw 45°](#try=line&k=300&b=2&xd=here&rpy=0,30,45)

## 6. The wall: a one-sided spring

A wall must push you **out** when you are inside it, and do **nothing** when you are outside.
It is the plane through $\mathbf{x}_d$ with outward normal $\mathbf{n}$, the third column of $\mathbf{R}$:

$$
\mathbf{n} = \mathbf{R}\begin{bmatrix} 0 \\ 0 \\ 1 \end{bmatrix}
$$

1. **Penetration depth** $d$, positive when the cursor is inside the wall:

$$
d = \mathbf{n}\cdot(\mathbf{x}_d - \mathbf{x})
$$

2. **Force**, only if $d > 0$:

$$
\mathbf{F} = \max\left(0,\ k\,d - b\,(\mathbf{n}\cdot\mathbf{v})\right)\mathbf{n}, \qquad \mathbf{F} = \mathbf{0} \text{ if } d \le 0
$$

The code, in `libs/myHAPLY_SCENARIOS.h`. Here $d$ is the third component of $\mathbf{e} = \mathbf{R}^\top(\mathbf{x}_d - \mathbf{x})$,
and `u.z()` is $\mathbf{n}\cdot\mathbf{v}$:

```cpp
        case Kind::Wall: {
            const double d = e.z();                         // penetration depth along the normal
            if (d <= 0.0) return Vec3::Zero();              // outside the wall: no force
            const double push = std::max(0.0, s.k.z() * d - s.b.z() * u.z());
            const Vec3 n = R.col(2);                        // outward normal = third column of R
            return push * n;
        }
```

## 7. Why $\max(0, \ldots)$?

Take $k = 500$ N/m, $b = 3$ N s/m, and a cursor 4 mm inside the wall ($d = 0.004$ m), so $k\,d = 2$ N.

1. **Moving in** at 0.1 m/s: $\mathbf{n}\cdot\mathbf{v} = -0.1$, so the push is $2 - 3 \times (-0.1) = 2.3$ N. The damper adds to the spring. Good.
2. **Pulling out fast** at 1 m/s: $\mathbf{n}\cdot\mathbf{v} = +1$, so $2 - 3 \times 1 = -1$ N. A negative push would **pull you back into the wall**.
3. $\max(0, -1) = 0$. The wall lets you go.

A real wall can push but never pull. The $\max(0, \ldots)$ makes the virtual wall behave the same.

- [▶ Try it: a wall facing device +z, at your hand](#try=wall&k=500&b=3&xd=here&rpy=0,0,0)
- [▶ Try it: a wall facing device +x (pitch 90°)](#try=wall&k=500&b=3&xd=here&rpy=0,90,0)

With `xd=here` the wall surface passes through your hand, so you start exactly on it.
Move against the normal to go in. (If $+z$ is up in your notes from lesson 01, the first one is a floor.)

## 8. The link to surgery

Robot-assisted surgery uses exactly these fixtures:

- **Guidance fixtures**: a line guide along a planned needle path, or a curve to trace while cutting.
  The surgeon stays in charge of speed; the fixture removes sideways wobble.
- **Forbidden-region fixtures**: a wall around a nerve or an artery, a no-go zone the tool cannot enter.
  It is one-sided on purpose: it never pulls the tool towards the structure it protects.

Further reading: L. B. Rosenberg, "Virtual fixtures: perceptual tools for telerobotic manipulation", IEEE VRAIS 1993;
J. J. Abbott, P. Marayong, A. M. Okamura, "Haptic virtual fixtures for robot-assisted manipulation", Robotics Research, Springer 2007.

## Check yourself

1. In the line guide, push 5 mm sideways. Does the page show about 1.5 N? Now move 5 cm along the line: what force do you get?
2. With the $+z$ wall ($k = 500$ N/m), press 2 mm in and hold still. Does the force match $500 \times 0.002 = 1$ N?
3. Press into the wall, then pull out quickly. Do you ever feel a tug back towards the wall? Which line of code prevents it?
4. For the wall with pitch $90^\circ$, which way is $\mathbf{n}$? Predict before you feel it, then check.
5. Design a no-go zone that protects everything below your hand **and** everything to your right. How many walls do you need, and with which rpy? (One built-in wall is not enough; lesson 07 shows how to write two.)
