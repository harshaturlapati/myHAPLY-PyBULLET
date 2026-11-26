# Rigid-body motion: poses and transforms

**You will learn:**
- how one $4 \times 4$ matrix $\mathbf{T}$ stores a position and an orientation together (SE(3))
- why points get $w = 1$ and directions (velocity, force) get $w = 0$
- how to chain transforms, and how `compose()` in `mySE3.h` builds $\mathbf{T}$
- that the target frame $(\mathbf{x}_d, \mathbf{R})$ of the lab is exactly such a pose

**Time:** 25 min

## 1. A pose = where + which way

A rigid body (a scalpel, a needle guide, the target frame of the lab) needs two things to be placed in space:

1. **where** it is: a position $\mathbf{p}$ (3 numbers, metres),
2. **which way** it faces: a rotation $\mathbf{R}$ ($3 \times 3$, lesson 02).

Put them in one $4 \times 4$ matrix, the **homogeneous transform**:

$$
\mathbf{T} = \begin{bmatrix} \mathbf{R} & \mathbf{p} \\ \mathbf{0}^\top & 1 \end{bmatrix}
$$

The set of all such matrices is called SE(3), the special Euclidean group: every rigid motion in 3-D.

## 2. Points get $w = 1$, directions get $w = 0$

Add a fourth number $w$ to every vector before multiplying by $\mathbf{T}$:

$$
\mathbf{T}\begin{bmatrix} \mathbf{q} \\ 1 \end{bmatrix} = \begin{bmatrix} \mathbf{R}\mathbf{q} + \mathbf{p} \\ 1 \end{bmatrix},
\qquad
\mathbf{T}\begin{bmatrix} \mathbf{d} \\ 0 \end{bmatrix} = \begin{bmatrix} \mathbf{R}\mathbf{d} \\ 0 \end{bmatrix}
$$

- A **point** (a position, $w = 1$) is rotated **and** moved.
- A **direction** ($w = 0$) is only rotated. Velocity and force are directions: moving the target frame
  10 cm to the left does not change how fast you move or which way a force points.

This is why the lab code uses $\mathbf{x}_d$ for the position error but only $\mathbf{R}$ for the velocity and the force.

## 3. Building $\mathbf{T}$ in code: `compose()`

`libs/myGEOMETRY/mySE3.h` (from the sibling Virtuose project) builds $\mathbf{T}$ by gluing blocks together.
First, the bottom row $[0\ 0\ 0\ 1]$:

```cpp
Eigen::RowVector4d padding(0, 0, 0, 1);
```

Then $[\mathbf{R}\ \mathbf{p}]$ side by side, and the bottom row underneath:

```cpp
Eigen::Matrix4d compose(Eigen::Vector3d p, Eigen::Matrix3d R) {
    Eigen::Matrix4d T;

    // Horizontal concatenation
    Eigen::MatrixXd T_interim(R.rows(), R.cols() + p.cols());
    T_interim << R, p;

    // Vertical concatenation
    T << T_interim, padding; // <-- syntax is the same for vertical and horizontal concatenation
    return T;
}
```

Note the order of the arguments: position first, then rotation, `compose(p, R)`.

## 4. Chaining transforms

If $\mathbf{T}_{ab}$ is the pose of frame $b$ seen from frame $a$, and $\mathbf{T}_{bc}$ is the pose of $c$ seen from $b$, then

$$
\mathbf{T}_{ac} = \mathbf{T}_{ab}\,\mathbf{T}_{bc} = \begin{bmatrix} \mathbf{R}_{ab}\mathbf{R}_{bc} & \mathbf{R}_{ab}\mathbf{p}_{bc} + \mathbf{p}_{ab} \\ \mathbf{0}^\top & 1 \end{bmatrix}
$$

Example: in PyBullet, $\mathbf{T}_{\text{world,device}}$ places the Inverse3 in the simulated room and
$\mathbf{T}_{\text{device,target}}$ places the target in the device frame. Their product places the target in the room.

**Order matters.** Take $\mathbf{T}_1$ = (yaw 90°, $\mathbf{p}_1 = (0.1, 0, 0)$) and $\mathbf{T}_2$ = (no rotation, $\mathbf{p}_2 = (0.05, 0, 0)$).

1. $\mathbf{T}_1\mathbf{T}_2$: position $\mathbf{R}_1\mathbf{p}_2 + \mathbf{p}_1 = (0, 0.05, 0) + (0.1, 0, 0) = (0.1, 0.05, 0)$ m.
2. $\mathbf{T}_2\mathbf{T}_1$: position $\mathbf{p}_1 + \mathbf{p}_2 = (0.15, 0, 0)$ m.

Same rotation, different place. "Move then turn" is not "turn then move".

## 5. Undoing a transform

Because $\mathbf{R}^{-1} = \mathbf{R}^\top$, the inverse is cheap:

$$
\mathbf{T}^{-1} = \begin{bmatrix} \mathbf{R}^\top & -\mathbf{R}^\top\mathbf{p} \\ \mathbf{0}^\top & 1 \end{bmatrix}
$$

So a device-frame point $\mathbf{x}$, seen from a frame with pose $(\mathbf{p}, \mathbf{R})$, is $\mathbf{R}^\top(\mathbf{x} - \mathbf{p})$.

## 6. The target frame of the lab is a pose

Every scenario has a target point $\mathbf{x}_d$ and an orientation $\mathbf{R}$ (from roll, pitch, yaw). Together they are a pose:

$$
\mathbf{T}_{\text{target}} = \begin{bmatrix} \mathbf{R} & \mathbf{x}_d \\ \mathbf{0}^\top & 1 \end{bmatrix}
$$

The struct that holds them, in `libs/myHAPLY_SCENARIOS.h`:

```cpp
    Vec3 x_d = Vec3::Zero();   // target point / a point on the line, plane or wall (m)
    Vec3 rpy = Vec3::Zero();   // orientation of the target frame (rad)
```

The cursor seen from the target frame is $\mathbf{T}^{-1}$ applied to $\mathbf{x}$, which is $\mathbf{R}^\top(\mathbf{x} - \mathbf{x}_d)$.
The code computes the same thing with the opposite sign (the error points **to** the target):

```cpp
    const Vec3 e = R.transpose() * (s.x_d - x);     // position error, target frame
```

The lab never builds the $4 \times 4$ matrix: two lines with $\mathbf{R}$ and $\mathbf{x}_d$ do the same arithmetic.

## 7. Worked example

Target $\mathbf{x}_d = (0.05, 0, 0.10)$ m, yaw $= 90^\circ$ (roll = pitch = 0). From lesson 02,

$$
\mathbf{T}_{\text{target}} = \begin{bmatrix} 0 & -1 & 0 & 0.05 \\ 1 & 0 & 0 & 0 \\ 0 & 0 & 1 & 0.10 \\ 0 & 0 & 0 & 1 \end{bmatrix}
$$

1. **A point** 1 cm along the target's own x axis, $\mathbf{q} = (0.01, 0, 0)$, $w = 1$:
   $\mathbf{R}\mathbf{q} + \mathbf{x}_d = (0, 0.01, 0) + (0.05, 0, 0.10) = (0.05, 0.01, 0.10)$ m in the device frame.
2. **A direction** $(1, 0, 0)$, $w = 0$: only rotated, $(0, 1, 0)$. The translation is ignored.
3. **The error.** Put the cursor at that point, $\mathbf{x} = (0.05, 0.01, 0.10)$. Then $\mathbf{x}_d - \mathbf{x} = (0, -0.01, 0)$ and
   $\mathbf{e} = \mathbf{R}^\top(0, -0.01, 0) = (-0.01, 0, 0)$ m: 1 cm on the target's $+x'$ side, as built in step 1.
4. **The force** of a line guide, $\mathbf{K} = \operatorname{diag}(300, 300, 0)$: $\mathbf{K}\mathbf{e} = (-3, 0, 0)$ N in the target
   frame, and $\mathbf{R}(-3, 0, 0) = (0, -3, 0)$ N in the device frame. It pulls you back to $\mathbf{x}_d$.

## 8. Feel the pose

Set the target where your hand is (`xd=here`), then tilt the frame. The position stays, the orientation changes.

- [▶ Try it: plane guide, flat](#try=plane&k=300&b=2&xd=here&rpy=0,0,0)
- [▶ Try it: plane guide tilted by roll 30°](#try=plane&k=300&b=2&xd=here&rpy=30,0,0)

The engine never jumps to a new pose: the target point moves at most 0.1 m/s and the angles at most 1 rad/s.

## Check yourself

1. With $\mathbf{x}_d = (0.05, 0, 0.10)$ and yaw $= 90^\circ$, where in the device frame is the point $\mathbf{q} = (0, 0.02, 0)$ of the target frame?
2. Why does `u = R.transpose() * v` not subtract anything, while `e` subtracts `x`? Use the words "point" and "direction".
3. Open the flat plane guide. Move inside the plane for 5 cm: what force does the page show? Now push 5 mm out of the plane: does the force match $300 \times 0.005 = 1.5$ N?
4. Change the target to a point 5 cm away. How long does the engine take to move the target there? (Hint: 0.1 m/s.)
5. Compute $\mathbf{T}\,\mathbf{T}^{-1}$ for the worked example. What should you get?
