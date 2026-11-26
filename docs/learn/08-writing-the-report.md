# Writing the report

**You will learn:**
- the six parts of a lab report and what goes in each
- what the Report tab fills in for you, and what you must still write and check
- how to cite the exact lines of code that implement your equations
- a checklist to run before you hand in

**Time:** 20 min

## 1. The structure

Use these headings, in this order. Unless your instructor says otherwise, aim for 4 to 6 pages.

1. **Aim.** One or two sentences, with a number in them.
   Example: "To check that the Inverse3 renders a stiffness of 300 N/m within 10 %."
2. **Theory.** The equations you test, every symbol defined, every unit given. Example:

$$
\mathbf{F} = \mathbf{R}\left(\mathbf{K}\,\mathbf{R}^\top(\mathbf{x}_d - \mathbf{x}) - \mathbf{B}\,\mathbf{R}^\top\mathbf{v}\right),
\qquad \mathbf{K} = \operatorname{diag}(k_x, k_y, k_z)\ \text{N/m}
$$

3. **Method.** Device (Inverse3 or simulator), scenario, **all** parameters ($k$, $b$, $\mathbf{x}_d$, rpy, `fmax`),
   what you did with your hand, how long you recorded, and the file names. Someone else must be able to repeat it.
4. **Results.** Plots and numbers. Every axis labelled with a unit. Every figure has a caption that says what to look at.
5. **Discussion.** Does the result match the theory? By how much? Why not exactly? What would you change?
6. **Code.** The lines that implement your equation, cited exactly (section 3). If you used the Equation lab,
   paste your three expressions exactly as typed.

Finish with **References** (the lessons, papers, the repository).

## 2. What the Report tab does for you

The Report tab saves typing by filling in what the console already knows, for example your recordings with
their scenario line and your notes, and the equations and code of the scenario you used. You still write the
aim, the discussion and the conclusions yourself.

**Check every number it fills in.** Each recording carries its own settings in its first lines. A typical one:

1. `Robot NAME:Inverse3` (or `Simulator`)
2. `# scenario: kind=impedance xd=[...] rpy=[...] k=[...] b=[...] fmax=...` with $\mathbf{x}_d$ in **m** and rpy in **radians**
3. `# columns: ...` explaining every column (lesson 01)

These lines come from the engine, in `lab/engine/haply_lab_engine.cpp`:

```cpp
        o << "# scenario: kind=" << haptics::kind_name(scn_.kind) << " xd=" << fmt3(xd_tgt_) << " rpy=" << fmt3(rpy_tgt_)
          << " k=" << fmt3(k_tgt_, 1) << " b=" << fmt3(b_tgt_, 2) << " fmax=" << fmax_ << "\n";
```

Copy parameters into your Method from there, not from memory. Convert rpy to degrees if you report degrees
($1\ \text{rad} = 57.3^\circ$).

## 3. Citing the exact code

Code changes over time, so a citation needs three things: **file**, **line numbers**, and the **line itself**.
Add the version too: the commit id (from `git log -1 --oneline` in the repository folder) or the date you used the lab.

Example citation for the impedance scenario:

> The force is computed in `libs/myHAPLY_SCENARIOS.h`, lines 97 to 98:

```cpp
            const Vec3 f_local = s.k.asDiagonal() * e - s.b.asDiagonal() * u;   // K e - B u
            return R * f_local;                                                 // back to the device frame
```

> Line 97 is $\mathbf{f}_{\text{local}} = \mathbf{K}\mathbf{e} - \mathbf{B}\mathbf{u}$ and line 98 is $\mathbf{F} = \mathbf{R}\,\mathbf{f}_{\text{local}}$.

Useful line numbers (open the Code tab to confirm them in your version):

| What | File | Lines |
|---|---|---|
| roll-pitch-yaw to $\mathbf{R}$ | `libs/myHAPLY_SCENARIOS.h` | 45 to 49 |
| error and velocity in the target frame | `libs/myHAPLY_SCENARIOS.h` | 88 to 89 |
| impedance (spring, line, plane, damping) | `libs/myHAPLY_SCENARIOS.h` | 97 to 98 |
| wall | `libs/myHAPLY_SCENARIOS.h` | 102 to 106 |
| custom equations | `libs/myHAPLY_SCENARIOS.h` | 110 to 113 |
| safety checks, fade-in, force cap | `lab/engine/haply_lab_engine.cpp` | 263 to 281 |

Always pair the code with the equation it implements, side by side, the way the lessons do.

## 4. Results that convince

1. **Show the raw data first**, for example $x$ and $F_x$ against time, so the reader trusts it.
2. **Then the analysis plot**, for example $F_x$ against $e_x$ with the fitted line and its slope.
3. **Give the number with an uncertainty.** Repeat 3 times and report the mean and the spread:
   "$k = 296 \pm 8$ N/m (mean $\pm$ standard deviation of 3 trials)".
4. **Compare in one sentence**: "1.3 % below the commanded 300 N/m."
5. **Leave out** rows where `ramp` < 1 or where the force sits at `fmax`, and say that you did.

## 5. A good discussion

Name the causes of error and say how you would test each. From the lessons, candidates are:

- the damping term $b\,v$ (move slower, or set $b$ smaller, and see if the loop shrinks),
- the force cap `fmax` (stay below it),
- the 1 ms sampling (lesson 06),
- your hand: tremor, and how firmly you hold.

Then connect to an application in one paragraph, for example a forbidden-region wall in surgery (lesson 05).

## 6. Checklist before you hand in

- [ ] The aim has a number in it.
- [ ] Every equation has its symbols and units defined.
- [ ] Every equation sits next to the code line that implements it, with file, line numbers and version.
- [ ] The Method lists every parameter, copied from the recording's `# scenario:` line.
- [ ] Every plot has axis labels with units and a caption.
- [ ] Every result has an uncertainty and a comparison with theory.
- [ ] The Discussion names at least two causes of error and how to test them.
- [ ] Custom equations are pasted exactly as typed.
- [ ] Recording file names are listed, so the data can be found again.
- [ ] References are complete.

## Check yourself

1. Open your `k300` recording from lesson 04. What does its `# scenario:` line say? Are the rpy values in degrees or radians?
2. Write the aim of your experiment in one sentence, with a number in it.
3. Which file and lines compute the force for your scenario? Quote them in the citation format of section 3.
4. Your measured $k$ differs from 300 N/m. Name two causes from lessons 04 and 06, and one quick test for each.
5. Give your Method section to a partner. Can they repeat your experiment from it alone, without asking you anything?
