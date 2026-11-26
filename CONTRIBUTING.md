# Contributing

Students are the main contributors here: every lesson, explanation and example can be improved by you.

## The easy ways (no coding)
- **Something unclear?** In the lab console, use "Was this lesson clear?" under a lesson, click a line number in the
  Code tab, or the Feedback tab. Or open an issue: *Something was unclear*.
- **Fix the documentation.** Lessons are Markdown files in `docs/learn/`. On GitHub open the file, press the pencil
  ("Edit"), change it, and propose the change: GitHub makes the fork and pull request for you. Maths uses LaTeX:
  `$k\,d$` inline, `$$ ... $$` on its own lines.
- **Propose an equation.** Write it in the console's Equation lab and press "Propose it as a new behaviour".

## Code
1. Fork, clone your fork, add `upstream` (see the console's *Build it yourself* tab).
2. Branch: `git checkout -b 02-virtual-wall upstream/main`.
3. New example: `NNN-Topic/NN_short_name.cpp` (CMake finds it). New haptic behaviour: a new `case` in
   `libs/myHAPLY_SCENARIOS.h`, plus its twin in `docs/app.js` (`forceOf`) so the simulator matches.
4. Build on at least one OS, run it on the device or in the simulator, open a pull request and say what you tested.

Rules: forces stay under `F_max` and are zero on exit; device code lives in `libs/`; never commit `build/`, logs,
recordings or Haply binaries.
