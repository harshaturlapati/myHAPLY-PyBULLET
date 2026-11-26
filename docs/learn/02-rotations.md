# Rotations

**You will learn:**
- what a rotation matrix $\mathbf{R}$ is and the three facts that make it special
- how roll, pitch and yaw build $\mathbf{R}$ in the lab code (Eigen `AngleAxisd`)
- the difference between $\mathbf{R}\mathbf{v}$ (rotate / back to the device frame) and $\mathbf{R}^\top\mathbf{v}$ (seen from the target frame)

**Time:** 25 min

## 1. Why you need rotations

A line guide along the device z axis is useful. A line guide along **any** direction is much more useful:
a needle path, a cut line, a tilted wall. The Play tab lets you tilt the guide with three angles,
roll, pitch and yaw. The code turns those three angles into one $3 \times 3$ matrix $\mathbf{R}$.

## 2. Three facts about a rotation matrix

A rotation matrix has three columns, and **each column is one of the rotated axes**, written in the device frame:

$$
\mathbf{R} = \begin{bmatrix} \mathbf{x}' & \mathbf{y}' & \mathbf{z}' \end{bmatrix}
$$

1. **Orthonormal.** Each column has length 1, and the columns are at right angles to each other.
2. **No mirror.** $\det \mathbf{R} = 1$ (a mirror would give $-1$).
3. **Easy inverse.** Because of fact 1, $\mathbf{R}^\top \mathbf{R} = \mathbf{I}$, so

$$
\mathbf{R}^{-1} = \mathbf{R}^\top
$$

You never need to invert a rotation matrix: just transpose it. The code relies on this.

## 3. The three elementary rotations

Turning by an angle $\theta$ about one axis:

$$
\mathbf{R}_x(\theta) = \begin{bmatrix} 1 & 0 & 0 \\ 0 & \cos\theta & -\sin\theta \\ 0 & \sin\theta & \cos\theta \end{bmatrix}, \quad
\mathbf{R}_y(\theta) = \begin{bmatrix} \cos\theta & 0 & \sin\theta \\ 0 & 1 & 0 \\ -\sin\theta & 0 & \cos\theta \end{bmatrix}, \quad
\mathbf{R}_z(\theta) = \begin{bmatrix} \cos\theta & -\sin\theta & 0 \\ \sin\theta & \cos\theta & 0 \\ 0 & 0 & 1 \end{bmatrix}
$$

## 4. Roll, pitch, yaw (Z-Y-X)

The lab uses roll $\phi$, pitch $\theta$ and yaw $\psi$ in this order:

$$
\mathbf{R} = \mathbf{R}_z(\psi)\, \mathbf{R}_y(\theta)\, \mathbf{R}_x(\phi)
$$

Read it from right to left: first roll about the device x axis, then pitch about the device y axis, then yaw about the
device z axis. **Order matters**: $\mathbf{R}_z \mathbf{R}_y \neq \mathbf{R}_y \mathbf{R}_z$ in general.

This is the exact code, in `libs/myHAPLY_SCENARIOS.h`:

```cpp
// Rotation matrix from roll, pitch, yaw (radians), Z-Y-X convention:  R = Rz(yaw) * Ry(pitch) * Rx(roll)
// Each AngleAxis is "turn by this angle about this axis"; multiplying them chains the turns.
inline Mat3 R_from_rpy(const Vec3& rpy) {
    return (Eigen::AngleAxisd(rpy.z(), Vec3::UnitZ()) *
            Eigen::AngleAxisd(rpy.y(), Vec3::UnitY()) *
            Eigen::AngleAxisd(rpy.x(), Vec3::UnitX())).toRotationMatrix();
}
```

Line by line:

1. `rpy.x()` is roll, `rpy.y()` is pitch, `rpy.z()` is yaw, all in **radians**. The page lets you type degrees and converts.
2. `Eigen::AngleAxisd(angle, axis)` means "turn by `angle` about `axis`", exactly $\mathbf{R}_z(\psi)$, $\mathbf{R}_y(\theta)$, $\mathbf{R}_x(\phi)$.
3. The `*` chains the turns in the same order as the equation.
4. `.toRotationMatrix()` turns the chain into the $3 \times 3$ matrix $\mathbf{R}$.

## 5. Worked example: yaw = 90°

Take $\phi = 0$, $\theta = 0$, $\psi = 90^\circ$. Then $\cos 90^\circ = 0$ and $\sin 90^\circ = 1$, so

$$
\mathbf{R} = \mathbf{R}_z(90^\circ) = \begin{bmatrix} 0 & -1 & 0 \\ 1 & 0 & 0 \\ 0 & 0 & 1 \end{bmatrix}
$$

1. **Apply it to** $(1, 0, 0)$: $\mathbf{R} \begin{bmatrix} 1 \\ 0 \\ 0 \end{bmatrix} = \begin{bmatrix} 0 \\ 1 \\ 0 \end{bmatrix}$. The x axis has turned onto the y axis.
2. **Read the columns.** $\mathbf{x}' = (0, 1, 0)$, $\mathbf{y}' = (-1, 0, 0)$, $\mathbf{z}' = (0, 0, 1)$. The first column is the answer of step 1: no extra work.
3. **Check the facts.** Each column has length 1, they are at right angles, and $\det \mathbf{R} = 0 \cdot 0 - (-1)\cdot 1 = 1$.

## 6. Rotating a vector vs changing the frame

The same matrix is used in two directions:

- $\mathbf{R}\,\mathbf{a}$: take a vector $\mathbf{a}$ written in the **target frame** and write it in the **device frame**.
- $\mathbf{R}^\top \mathbf{a}$: take a vector written in the **device frame** and see it **from the target frame**.

The force function uses both. First it looks at the error and the velocity from the target frame:

$$
\mathbf{e} = \mathbf{R}^\top(\mathbf{x}_d - \mathbf{x}), \qquad \mathbf{u} = \mathbf{R}^\top \mathbf{v}
$$

```cpp
    const Mat3 R = R_from_rpy(s.rpy);
    const Vec3 e = R.transpose() * (s.x_d - x);     // position error, target frame
    const Vec3 u = R.transpose() * v;               // velocity, target frame
```

Then, after computing the force in the target frame, it turns the force back into the device frame:

```cpp
            return R * f_local;                                                 // back to the device frame
```

**Numbers.** Yaw = 90°, and the cursor is 1 cm on the $-x$ side of the target: $\mathbf{x}_d - \mathbf{x} = (0.01, 0, 0)$ m.

1. $\mathbf{R}^\top = \begin{bmatrix} 0 & 1 & 0 \\ -1 & 0 & 0 \\ 0 & 0 & 1 \end{bmatrix}$, so $\mathbf{e} = \mathbf{R}^\top (0.01, 0, 0) = (0, -0.01, 0)$ m. Seen from the target frame, the error is along its $-y'$ axis.
2. Line guide, $\mathbf{K} = \operatorname{diag}(300, 300, 0)$ N/m: $\mathbf{K}\mathbf{e} = (0, -3, 0)$ N in the target frame.
3. Back to the device frame: $\mathbf{R}\,(0, -3, 0) = (3, 0, 0)$ N. It points from $\mathbf{x}$ to $\mathbf{x}_d$, as a spring should.
   (On the device it is capped at `fmax`, so with `fmax` = 2 N you would feel 2 N.)

## 7. Feel it

The line guide is free along the third column $\mathbf{z}'$ of $\mathbf{R}$. Tilt it and feel the free direction move.

- [▶ Try it: line guide, no tilt (free along device z)](#try=line&k=300&b=2&xd=here&rpy=0,0,0)
- [▶ Try it: line guide, pitch 90° (free along device x)](#try=line&k=300&b=2&xd=here&rpy=0,90,0)
- [▶ Try it: line guide, pitch 45° (free along a diagonal)](#try=line&k=300&b=2&xd=here&rpy=0,45,0)

For pitch $90^\circ$: $\mathbf{R}_y(90^\circ)$ has third column $(\sin 90^\circ, 0, \cos 90^\circ) = (1, 0, 0)$, the device x axis.

## 8. Older helpers in the repository

`libs/myGEOMETRY/myROT.h` comes from the sibling Virtuose project. Its `R_frm_quat` builds $\mathbf{R}$ from a
**quaternion** $(x, y, z, w)$, the way PyBullet stores orientations. The lab does not use it.
Optional challenge: take the quaternion of a 90° turn about y, $(0, 0.7071, 0, 0.7071)$, work out its matrix by
hand from the `a11 ... a33` lines of `R_frm_quat`, and test fact 3: is $\mathbf{R}^\top\mathbf{R} = \mathbf{I}$?
This exact test found a real bug while these lessons were written: `a11` had $+y^2$ instead of $-y^2$, so this
rotation gave $a_{11} = 1$ instead of $0$. It is fixed now; checking a formula against a property it must satisfy
is how you catch such mistakes. Found another one? Report it in the Feedback tab.

## Check yourself

1. Write $\mathbf{R}$ for roll $= 90^\circ$ (pitch = yaw = 0). What is its third column? Where does a wall with this rpy face?
2. Open a wall with rpy $= 0, 0, 90$ and then with rpy $= 0, 0, 0$. Do they feel different? Explain with the third column of $\mathbf{R}_z$.
3. With the pitch-45° line guide, move along the free direction for 5 cm. How much do your device $x$ and $z$ each change? Is it about $5 \cos 45^\circ = 3.5$ cm each?
4. Compute $\mathbf{R}_z(90^\circ)\mathbf{R}_y(90^\circ)$ and $\mathbf{R}_y(90^\circ)\mathbf{R}_z(90^\circ)$. Are they the same?
5. In the worked example of section 6, set $k = 300$ N/m and push 5 mm instead of 1 cm. What force should the page show?
