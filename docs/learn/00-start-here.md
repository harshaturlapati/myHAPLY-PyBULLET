# Start here: meet the Inverse3

**You will learn:**
- what the Haply Inverse3 is, and the names of its parts
- the safety rules, and how to calibrate the device after every power-up
- what each tab of the lab console is for, and why only one person drives at a time

**Time:** 15 min

## 1. What the Inverse3 does

The Haply Inverse3 is a desktop **haptic device**: a small robot arm that you hold by its handle.
About a thousand times per second it does two things:

1. It **measures** where the handle is: position $\mathbf{x}$ in metres (m) and velocity $\mathbf{v}$ in metres per second (m/s).
2. It **pushes** on your hand with a force $\mathbf{F}$ in newtons (N), worked out by our code.

It has 3 motors, so it has 3 degrees of freedom (3-DOF). It can push your hand along x, y and z, but it
cannot twist your wrist: it renders **forces only, no torques**.

To get a feel for the numbers: 1 N is roughly the weight of a 100 g apple. The lab never lets the
device push harder than 4 N (about the weight of a 400 g bottle of water).

## 2. The parts

| Part | What it is for |
|---|---|
| Base | Holds the three motors. Keep it flat and still on the desk. |
| Front LED | Shows the device status. **Purple = not calibrated.** |
| Arms | The linkage between the motors and your hand. Fold them together to stow the device. |
| Cursor (handle) | The end of the arm that you hold. Its position is $\mathbf{x}$. |
| VerseGrip stylus (if fitted) | A pen-like handle. It sets its "home" orientation when you switch it on, so put it down still first. |
| Magnetic dock | Where you rest the cursor to calibrate. |
| USB cable | Data. Enough to read position and velocity. |
| Motor power cable | Needed only for forces. |

## 3. Safety rules

Read these out loud with your lab partner before you start.

1. **Unplug the motor power** whenever nobody is actively using the device. Otherwise the drives stay energised.
2. When you plug the motor power in, expect a **small jump** of the arm. Keep your face and fingers clear of the arms.
3. **Hold the handle whenever forces are on.** Never switch forces on and walk away.
4. **Don't leave the cursor resting in the dock.** Calibrate, then lift it off and move it away.
5. To **stow** the device, fold the arms together (pinch) and pull back until it clicks. That locks it.
6. If anything feels wrong (buzzing, a sudden push), **keep a firm grip and switch forces off** in the console
   (with your other hand, or ask your partner). Your grip calms the arm; letting go does not.

## 4. Calibrate after every power-up

After power-up the Inverse3 knows its joint angles but not where the cursor is. Until it is calibrated
it reports $\mathbf{x} = 0$ and $\mathbf{v} = 65535$ (a "nothing yet" marker), and the console refuses to switch forces on.

1. Plug in the USB cable. (Motor power is not needed to calibrate.)
2. Look at the front LED. **Purple** means "needs calibration".
3. Rest the cursor on the **magnetic dock** and leave it there until the LED **changes colour**.
4. Lift the cursor off the dock.
5. Move the handle and watch the position numbers on the Start or Play tab. They should change smoothly.

This is how the code decides "calibrated or not". In `libs/myHAPLY_v1.h`:

```cpp
    // Until the device is calibrated, firmware 7.x returns X = 0 and V = 65535 (no cursor position yet).
    bool calibrated = false;
```

and, after every exchange with the device:

```cpp
        calibrated = !(V[0] >= 65000.0f && V[1] >= 65000.0f && V[2] >= 65000.0f);
```

If you try to switch forces on too early, the page shows the engine's message
`cannot switch forces on: the device is not calibrated`.

## 5. A tour of the console

| Tab | Use it to |
|---|---|
| **Start** | Connect, check that the device is calibrated, and take control. |
| **Play** | Pick a preset (free, spring, line, plane, wall, damping, custom), set $k$ and $b$, and switch forces on and off. |
| **Experiment** | Record your motion and forces at the full 1 kHz rate to a CSV file, add notes, download it. |
| **Learn** | These lessons. The "▶ Try it" links open the Play tab with the settings filled in. |
| **Code** | Read the real C++ source, with explanations beside the important lines. |
| **Equation lab** | Type your own force equations $F_x, F_y, F_z$ and feel them (lesson 07). |
| **Report** | Build your lab report from your recordings and notes (lesson 08). |
| **Terminal** | A restricted Linux shell on the lab computer, for running and building examples. |
| **Feedback** | Tell the instructor what was confusing or broken. Short and specific helps most. |
| **Build it yourself** | Build the C++ examples on your own laptop (Windows or Linux). |

## 6. One person drives at a time

Everybody can **watch** the live data, but only **one** person can **drive** (send commands) at a time.

1. On the Start tab, take control. Others now see your name as the driver.
2. If someone else is driving, the page tells you to `take control first (only one person drives the device at a time)`.
3. When you are done, **release control**. Releasing switches the forces off.
4. If your page goes quiet (closed tab, laptop asleep), you lose control after about 3 s and forces switch off.

Agree with your group who drives, and swap every few minutes.

## 7. Your first five minutes

1. Calibrate (section 4). Lift the cursor off the dock.
2. Take control on the Start tab.
3. Open free motion and move the handle. Nothing should push you.
   [▶ Try it: free motion, no forces](#try=free)
4. Hold the handle, then open a soft spring that is anchored where your hand is now. Switch forces on.
   You will feel the force **fade in over 1 s**.
   [▶ Try it: a soft spring at your hand](#try=spring&k=100&b=1&xd=here)
5. Move 1 cm away from where you started and feel the pull back. Switch forces off. Release control.

## Check yourself

1. Before calibrating, what position does the page show? What velocity? Why 65535 and not 0?
2. Rest the cursor in the dock. How many seconds pass before the LED changes colour?
3. With the soft spring ($k = 100$ N/m), move 1 cm away. The page shows the force: is it close to $100 \times 0.01 = 1$ N?
4. Ask a partner to take control while you are driving. What do they see?
5. Close your browser tab while forces are on (hold the handle!). How long until the forces stop?
