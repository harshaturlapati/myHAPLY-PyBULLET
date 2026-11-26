/* Haply lab console - browser side.
 *
 * Two modes, same page:
 *   LIVE       served by lab/haply_lab.py on the lab Pi: real device (or the engine's simulator), live stream,
 *              recordings, code browser, terminal, feedback to the instructor.
 *   SIMULATOR  opened from GitHub Pages (or any static copy): the cursor is a virtual hand you drag with the
 *              mouse, and the forces are computed here in JavaScript with the same equations as the C++ engine.
 *
 * Structure: utilities - expression grammar (twin of libs/myEXPR.h) - scenario maths (twin of
 * libs/myHAPLY_SCENARIOS.h) - local simulator (twin of lab/engine) - connection - one block per tab.
 */
(() => {
"use strict";

const GITHUB = "https://github.com/harshaturlapati/myHAPLY-PyBULLET";
const RAW = "https://raw.githubusercontent.com/harshaturlapati/myHAPLY-PyBULLET/main/";
const PAGES = "https://harshaturlapati.github.io/myHAPLY-PyBULLET/";

// =========================================================================================== utilities
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem("myhaply." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("myhaply." + k, JSON.stringify(v)); } catch {} },
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "–");
const mm = v => fmt(v * 1000, 1);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const deg = r => r * 180 / Math.PI, rad = d => d * Math.PI / 180;
const norm3 = a => Math.hypot(a[0], a[1], a[2]);
const vec3 = v => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v : null);   // a usable [x, y, z], or null
const firstNum = (...v) => { for (const x of v) if (typeof x === "number" && Number.isFinite(x)) return x; return null; };

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

let toastTimer, toastHoldUntil = 0;
// hold (ms): the engine's routine messages ("scenario: wall", "forces off") do not replace this one for that long,
// so an instruction such as "switch forces on again" stays readable.
function toast(text, kind = "info", hold = 0) {
  if (hold) toastHoldUntil = performance.now() + hold;
  let t = $(".toast");
  if (!t) { t = h("div", { class: "toast", role: "status" }); document.body.append(t); }
  t.textContent = text;
  t.style.borderLeftColor = kind === "bad" ? css("--critical") : kind === "good" ? css("--good") : css("--accent");
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4500);
}

function status(kind, text, extra) {
  const icon = { good: "✓", warn: "!", bad: "×", info: "i" }[kind] || "i";
  return h("div", { class: "status " + kind }, h("span", { class: "ic", "aria-hidden": "true", text: icon }), h("div", {}, text, extra || null));
}

function modal(title, body, buttons) {
  return new Promise(resolve => {
    const bg = h("div", { class: "modal-bg" });
    const box = h("div", { class: "modal", role: "dialog", "aria-modal": "true" }, h("h3", { text: title }), body);
    const row = h("div", { class: "row", style: "justify-content:flex-end;margin-top:14px" });
    buttons.forEach(b => row.append(h("button", { class: "btn " + (b.cls || ""), type: "button", onclick: () => {
      if (b.check && !b.check()) return;
      bg.remove(); resolve(b.value);
    } }, b.label)));
    box.append(row); bg.append(box); document.body.append(bg);
    const first = box.querySelector("input,textarea,button"); if (first) first.focus();
  });
}

function codeBlock(text) {
  const pre = h("pre", { text });
  const b = h("button", { class: "btn small copy", type: "button", text: "Copy", onclick: () => copy(pre.textContent, b) });
  return h("div", { class: "code" }, pre, b);
}
function copy(text, btn) {
  const done = () => { if (!btn) return; const o = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = o), 1200); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  function fallback() { const t = h("textarea"); t.value = text; document.body.append(t); t.select(); try { document.execCommand("copy"); done(); } catch {} t.remove(); }
}

function tex(src, display = true) {
  if (!window.temml) return h("code", { text: src });
  const span = h("span", { class: display ? "math-display" : "math-inline" });
  try { span.innerHTML = temml.renderToString(src, { displayMode: display, throwOnError: false }); } catch { span.textContent = src; }
  return span;
}
function texString(src, display = true) {
  try { return window.temml ? temml.renderToString(src, { displayMode: display, throwOnError: false }) : esc(src); } catch { return esc(src); }
}

// =========================================================================================== expressions
// Twin of libs/myEXPR.h: same grammar (plain decimal numbers only: 12  1.5  1.  .5  2e-3, no hex), same variable
// names, same error messages, the same 32-slot stack limit, and the same results, NaN included (min, max, sign,
// clamp and pow are written out below exactly as min_js, max_js, pow_js and clamp3 in myEXPR.h).
// parseExpr also applies the limits that the lab server and engine put on every "expr fx <text>" command
// (at most 240 characters, plain printable ASCII only), so the page never offers an equation that would be
// refused on its way to the device.
const EXPR_VARS = ["x", "y", "z", "vx", "vy", "vz", "t", "xd", "yd", "zd", "kx", "ky", "kz", "bx", "by", "bz"];
const F1 = ["sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "sqrt", "abs", "sign", "step", "floor"];
const F2 = ["min", "max", "atan2", "pow"];
const EXPR_MAX_LEN = 240;     // the server's whitelist: ^expr (fx|fy|fz) [ -~]{0,240}$
const EXPR_STACK = 32;        // myEXPR.h STACK: deeper equations are refused ("too deeply nested")

function parseExpr(src) {
  src = String(src);
  if (src.length > EXPR_MAX_LEN) return { err: `the equation is longer than ${EXPR_MAX_LEN} characters` };
  if (/[^ -~]/.test(src)) return { err: "only plain ASCII characters are allowed (no tabs, special spaces or symbols)" };
  let pos = 0, err = null;
  const s = src;
  const skip = () => { while (pos < s.length && " \t\n\v\f\r".includes(s[pos])) pos++; };   // C isspace()
  const eat = c => { skip(); if (s[pos] === c) { pos++; return true; } return false; };
  const fail = m => { if (!err) err = `${m} at position ${pos + 1}`; return null; };
  function expr() { let a = term(); if (!a) return null;
    for (;;) { if (eat("+")) { const b = term(); if (!b) return null; a = { t: "bin", op: "+", a, b }; }
      else if (eat("-")) { const b = term(); if (!b) return null; a = { t: "bin", op: "-", a, b }; } else return a; } }
  function term() { let a = unary(); if (!a) return null;
    for (;;) { if (eat("*")) { const b = unary(); if (!b) return null; a = { t: "bin", op: "*", a, b }; }
      else if (eat("/")) { const b = unary(); if (!b) return null; a = { t: "bin", op: "/", a, b }; } else return a; } }
  function unary() { if (eat("-")) { const a = unary(); return a && { t: "neg", a }; } if (eat("+")) return unary(); return power(); }
  function power() { const a = primary(); if (!a) return null; if (eat("^")) { const b = unary(); return b && { t: "bin", op: "^", a, b }; } return a; }
  function primary() {
    skip();
    if (pos >= s.length) return fail("equation ends too early");
    const c = s[pos];
    if (c === "(") { pos++; const a = expr(); if (!a) return null; if (!eat(")")) return fail("missing ')'"); return { t: "par", a }; }
    // digits [. digits]  or  . digits,  then an optional exponent e[+-]digits ("2e" without digits is the number 2)
    const num = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(s.slice(pos));
    if (num) { pos += num[0].length; return { t: "num", v: parseFloat(num[0]) }; }
    const id = /^[A-Za-z_]\w*/.exec(s.slice(pos));
    if (id) {
      const start = pos; pos += id[0].length; const name = id[0]; skip();
      if (s[pos] === "(") {
        const n = F1.includes(name) ? 1 : F2.includes(name) ? 2 : name === "clamp" ? 3 : 0;
        if (!n) { pos = start; return fail(`unknown function '${name}'`); }
        pos++; const args = [];
        for (let i = 0; i < n; i++) {
          if (i > 0 && !eat(",")) return fail(`'${name}' needs ${n} arguments`);
          const a = expr(); if (!a) return null; args.push(a);
        }
        if (!eat(")")) return fail(`missing ')' after the arguments of '${name}'`);
        return { t: "call", name, args };
      }
      if (name === "pi") return { t: "num", v: Math.PI, pi: true };
      if (EXPR_VARS.includes(name)) return { t: "var", name };
      pos = start; return fail(`unknown name '${name}'`);
    }
    return fail(`unexpected '${c}'`);
  }
  skip();
  if (pos >= s.length) return { err: "empty equation" };
  const ast = expr();
  skip();
  if (!ast || pos !== s.length) return { err: err || `unexpected '${s[pos]}' at position ${pos + 1}` };
  // The engine evaluates the equation on a fixed stack of EXPR_STACK numbers. This is the most it ever holds:
  // a number or variable needs 1 place; a op b needs a's places, then 1 (a's result) + b's places; f(a, b, c)
  // needs max(a's, 1 + b's, 2 + c's).
  const depth = n => n.t === "num" || n.t === "var" ? 1 : n.t === "par" || n.t === "neg" ? depth(n.a)
    : n.t === "bin" ? Math.max(depth(n.a), 1 + depth(n.b)) : Math.max(...n.args.map((a, i) => i + depth(a)));
  if (depth(ast) > EXPR_STACK) return { err: "equation is too deeply nested" };
  return { ast };
}
// min, max, pow, sign and clamp exactly as myEXPR.h computes them (min_js, max_js, pow_js, clamp3): a NaN input
// ("not a number", e.g. log of a negative number) gives NaN, which the engine and the simulator turn into zero force.
// clamp(v, lo, hi) is min(max(v, lo), hi): if lo > hi by mistake, the result is always hi, on the page and on the device.
const emin = (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : a < b ? a : b);
const emax = (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : a > b ? a : b);
const epow = (a, b) => (Number.isNaN(b) || (Math.abs(b) === Infinity && Math.abs(a) === 1) ? NaN : Math.pow(a, b));
const eclamp = (v, lo, hi) => emin(emax(v, lo), hi);
function evalAst(n, V) {
  switch (n.t) {
    case "num": return n.v;
    case "var": return V[n.name];
    case "par": return evalAst(n.a, V);
    case "neg": return -evalAst(n.a, V);
    case "bin": { const a = evalAst(n.a, V), b = evalAst(n.b, V);
      return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : n.op === "/" ? a / b : epow(a, b); }
    case "call": { const a = n.args.map(x => evalAst(x, V));
      switch (n.name) {
        case "sign": return Number.isNaN(a[0]) ? a[0] : (a[0] > 0) - (a[0] < 0); case "step": return a[0] > 0 ? 1 : 0; case "abs": return Math.abs(a[0]);
        case "min": return emin(a[0], a[1]); case "max": return emax(a[0], a[1]); case "pow": return epow(a[0], a[1]);
        case "clamp": return eclamp(a[0], a[1], a[2]);
        default: return Math[n.name](...a);           // sin cos tan asin acos atan exp log sqrt floor atan2: same as <cmath>
      } }
  }
  return 0;
}
const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 };
const TEXVAR = { x: "x", y: "y", z: "z", vx: "v_x", vy: "v_y", vz: "v_z", t: "t", xd: "x_d", yd: "y_d", zd: "z_d",
  kx: "k_x", ky: "k_y", kz: "k_z", bx: "b_x", by: "b_y", bz: "b_z" };
function numStr(v) {                               // 1e-7 is shown as 1 x 10^-7, not as "1e-7"
  if (!Number.isFinite(v)) return "\\infty";
  const s = Number.isInteger(v) && v < 1e21 ? String(v) : String(+v.toPrecision(6));
  const m = /^([^e]+)e([-+]?)(\d+)$/.exec(s);
  return m ? `${m[1]}\\times 10^{${m[2] === "-" ? "-" : ""}${m[3]}}` : s;
}
// LaTeX for the parse tree. The brackets the student typed are kept ("par" nodes); extra ones are added only where
// the LaTeX would otherwise read differently from what is computed: pow(x - xd, 2) is (x - x_d)^2, not x - x_d^2;
// pow(-x, 2) is (-x)^2, not -x^2; x*-2 is x . (-2), not "x - 2".
function toTex(n) {
  const T = toTex, br = m => `\\left(${T(m)}\\right)`;
  const atom = m => m.t === "var" || m.t === "par" || (m.t === "num" && (m.pi || !/times|infty/.test(numStr(m.v))));
  const isSum = m => m.t === "bin" && PREC[m.op] === 1;
  const leadsWithDigit = m => (m.t === "num" && !m.pi) || (m.t === "bin" && m.op !== "/" && leadsWithDigit(m.a)) ||
    (m.t === "call" && m.name === "pow" && atom(m.args[0]) && leadsWithDigit(m.args[0]));
  switch (n.t) {
    case "num": return n.pi ? "\\pi" : numStr(n.v);
    case "var": return TEXVAR[n.name];
    case "par": return br(n.a);
    case "neg": return n.a.t === "neg" || isSum(n.a) ? `-${br(n.a)}` : `-${T(n.a)}`;
    case "bin":
      if (n.op === "/") return `\\frac{${T(n.a)}}{${T(n.b)}}`;
      if (n.op === "^") return `{${atom(n.a) || (n.a.t === "call" && n.a.name !== "pow") ? T(n.a) : br(n.a)}}^{${T(n.b)}}`;
      if (n.op === "*") {
        const A = isSum(n.a) ? br(n.a) : T(n.a);
        const B = n.b.t === "neg" || isSum(n.b) ? br(n.b) : T(n.b);
        return A + (n.b.t === "neg" || leadsWithDigit(n.b) ? " \\cdot " : "\\,") + B;   // 2*3 is 2 . 3, not "23"
      }
      return `${T(n.a)} ${n.op} ${n.b.t === "neg" || isSum(n.b) ? br(n.b) : T(n.b)}`;   // a - (-b), a - (b - c)
    case "call": {
      const a = n.args.map(T);
      if (n.name === "sqrt") return `\\sqrt{${a[0]}}`;
      if (n.name === "abs") return `\\left|${a[0]}\\right|`;
      if (n.name === "pow") return `{${atom(n.args[0]) ? a[0] : br(n.args[0])}}^{${a[1]}}`;
      if (["sin", "cos", "tan", "exp", "log", "min", "max"].includes(n.name)) return `\\${n.name}\\left(${a.join(",\\ ")}\\right)`;
      return `\\operatorname{${n.name}}\\left(${a.join(",\\ ")}\\right)`;
    }
  }
  return "";
}
const CPPVAR = { x: "x.x()", y: "x.y()", z: "x.z()", vx: "v.x()", vy: "v.y()", vz: "v.z()", t: "t",
  xd: "s.x_d.x()", yd: "s.x_d.y()", zd: "s.x_d.z()", kx: "s.k.x()", ky: "s.k.y()", kz: "s.k.z()", bx: "s.b.x()", by: "s.b.y()", bz: "s.b.z()" };
// C++ for the parse tree, written so that it compiles with any compiler and computes what the engine computes for
// ordinary numbers: every number is a double literal (so 1/2 is 0.5, never integer division), pi is written out
// (M_PI is not standard C++ and is missing on MSVC), every minus sign gets its own brackets (so --x never becomes
// the C++ decrement operator) and the brackets the student typed are kept. (Only NaN can come out differently:
// std::min and std::max do not pass a NaN on the way myEXPR.h does.)
function cppNum(v) {
  if (!Number.isFinite(v)) return "HUGE_VAL";       // e.g. 1e999: myEXPR.h (strtod) also reads it as infinity
  const s = String(v);                               // shortest exact form: 0.5, 300, 1e-7, 1e+21
  return /[.eE]/.test(s) ? s : s + ".0";
}
function toCpp(n) {
  const C = toCpp;
  switch (n.t) {
    case "num": return n.pi ? "3.14159265358979323846" : cppNum(n.v);
    case "var": return CPPVAR[n.name];
    case "par": return `(${C(n.a)})`;
    case "neg": return `(-${C(n.a)})`;
    case "bin": {
      if (n.op === "^") return `std::pow(${C(n.a)}, ${C(n.b)})`;
      // The parser never puts a + or - directly under a * or / (that needs typed brackets, which are kept),
      // but bracket anyway so the C++ can never mean something else.
      const low = (m, right) => m.t === "bin" && m.op !== "^" && (right ? PREC[m.op] <= PREC[n.op] : PREC[m.op] < PREC[n.op]);
      const A = low(n.a, false) ? `(${C(n.a)})` : C(n.a);
      // MSVC refuses a division of constants by zero, such as 1.0 / 0.0 (error C2124). a / 0 is a times infinity
      // in IEEE arithmetic (0 / 0 and 0 * infinity are both NaN), so write it that way.
      const konst = m => m.t === "num" || ((m.t === "par" || m.t === "neg") && konst(m.a)) || (m.t === "bin" && konst(m.a) && konst(m.b));
      if (n.op === "/" && konst(n.a) && konst(n.b) && evalAst(n.b, {}) === 0) return `${A} * ${Object.is(evalAst(n.b, {}), -0) ? "(-HUGE_VAL)" : "HUGE_VAL"}`;
      return `${A} ${n.op} ${low(n.b, true) ? `(${C(n.b)})` : C(n.b)}`;
    }
    case "call": {
      const a = n.args.map(C);
      if (n.name === "step") return `(${a[0]} > 0.0 ? 1.0 : 0.0)`;
      if (n.name === "sign") return `double((${a[0]} > 0.0) - (${a[0]} < 0.0))`;
      if (n.name === "clamp") return `std::min(std::max(${a[0]}, ${a[1]}), ${a[2]})`;   // = clamp(v, lo, hi), also when lo > hi
      if (n.name === "abs") return `std::fabs(${a[0]})`;
      return `std::${n.name}(${a.join(", ")})`;      // sin cos ... floor, min max atan2 pow
    }
  }
  return "0.0";
}

// =========================================================================================== scenario maths
// Twin of libs/myHAPLY_SCENARIOS.h
function R_from_rpy([r, p, y]) {          // R = Rz(yaw) Ry(pitch) Rx(roll), returned as rows
  const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  return [[cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
          [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
          [-sp, cp * sr, cp * cr]];
}
// An angle in (-pi, pi]: the engine stores roll, pitch and yaw targets this way, so a typo such as 900 degrees
// never turns the frame round and round for seconds.
const wrapPi = a => { let r = a % (2 * Math.PI); if (r > Math.PI) r -= 2 * Math.PI; else if (r <= -Math.PI) r += 2 * Math.PI; return r; };
const mul = (R, a) => [0, 1, 2].map(i => R[i][0] * a[0] + R[i][1] * a[1] + R[i][2] * a[2]);
const mulT = (R, a) => [0, 1, 2].map(i => R[0][i] * a[0] + R[1][i] * a[1] + R[2][i] * a[2]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function forceOf(s, x, v, t) {             // s = {kind, xd, rpy(rad), k, b, ast:{fx,fy,fz}}
  const R = R_from_rpy(s.rpy);
  const e = mulT(R, sub(s.xd, x));
  const u = mulT(R, v);
  let F = [0, 0, 0];
  if (s.kind === "impedance") F = mul(R, [0, 1, 2].map(i => s.k[i] * e[i] - s.b[i] * u[i]));
  else if (s.kind === "wall") {
    const d = e[2];
    if (d > 0) { const push = Math.max(0, s.k[2] * d - s.b[2] * u[2]); F = [R[0][2] * push, R[1][2] * push, R[2][2] * push]; }
  } else if (s.kind === "custom") {
    const V = { x: x[0], y: x[1], z: x[2], vx: v[0], vy: v[1], vz: v[2], t, xd: s.xd[0], yd: s.xd[1], zd: s.xd[2],
      kx: s.k[0], ky: s.k[1], kz: s.k[2], bx: s.b[0], by: s.b[1], bz: s.b[2] };
    F = ["fx", "fy", "fz"].map(a => (s.ast && s.ast[a] ? evalAst(s.ast[a], V) : 0));
  }
  return { F, e };
}

// =========================================================================================== local simulator
// Twin of lab/engine/haply_lab_engine.cpp (simulator mode) for the GitHub Pages copy of the console.
// Same commands, same rate limits, and the same force pipeline every 1 ms:
//   F = equation  ->  not finite? zero  ->  |F| capped at the force limit in use  ->  times the fade-in (0..1 over 1 s)
class LocalSim {
  constructor() {
    this.t0 = performance.now() / 1000; this.tl = 0;
    this.x = [0, 0, 0]; this.v = [0, 0, 0]; this.F = [0, 0, 0]; this.e = [0, 0, 0]; this.hand = [0, 0, 0];
    this.scn = { kind: "free", xd: [0, 0, 0], rpy: [0, 0, 0], k: [0, 0, 0], b: [0, 0, 0], ast: {} };
    this.tgt = { xd: [0, 0, 0], rpy: [0, 0, 0], k: [0, 0, 0], b: [0, 0, 0] };
    this.src = { fx: "", fy: "", fz: "" };
    this.fmax = 2; this.fmaxNow = 2;           // the force limit asked for, and the one in use (rises at most 2 N/s)
    this.on = false; this.ramp = 0; this.msg = "simulator: drag in the views to move the virtual hand"; this.msg_id = 1;
    this.drag = null; this.dragUntil = 0; this.rec = null; this.recs = []; this.lastFile = "";
  }
  setMsg(m) { this.msg = m; this.msg_id++; }
  handle(c) {
    const p = c.split(" ");
    if (p[0] === "forces") {
      const on = p[1] === "1";
      if (on && !this.on) { this.ramp = 0; this.setMsg("forces ON (fading in over 1 s)"); }   // already on: no restart of the fade-in
      if (!on && this.on) this.setMsg("forces off");
      this.on = on;
    }
    else if (p[0] === "set") {
      if (p[1] === "kind") {
        if (!["free", "impedance", "wall", "custom"].includes(p[2])) { this.setMsg(`unknown scenario '${p[2]}'`); return; }
        if (this.scn.kind !== p[2]) { this.scn.kind = p[2]; this.ramp = 0; this.setMsg("scenario: " + p[2]); }
      }
      else if (p[1] === "fmax") {
        const f = +p[2];
        if (!Number.isFinite(f)) { this.setMsg("'set fmax' needs a number"); return; }
        this.fmax = clamp(f, 0, 4);
        if (this.fmax < this.fmaxNow) this.fmaxNow = this.fmax;       // a lower limit applies at once
      }
      else { const v = p.slice(2, 5).map(Number);
        if (v.length !== 3 || !v.every(Number.isFinite)) { this.setMsg(`'set ${p[1]}' needs three numbers`); return; }
        if (p[1] === "xd") this.tgt.xd = v.map(a => clamp(a, -0.3, 0.3));
        else if (p[1] === "rpy") this.tgt.rpy = v.map(wrapPi);
        else if (p[1] === "k") this.tgt.k = v.map(a => clamp(a, 0, 1000));
        else if (p[1] === "b") this.tgt.b = v.map(a => clamp(a, 0, 15));
        else this.setMsg(`unknown parameter '${p[1]}'`); }
    } else if (p[0] === "expr") {
      const axis = p[1], text = p.slice(2).join(" ").replace(/^ +/, "");
      if (!["fx", "fy", "fz"].includes(axis)) { this.setMsg("expr needs fx, fy or fz"); return; }
      if (!text || text === "0") {                 // "0" clears the equation; the fade-in restarts only if that changed it
        if (this.src[axis]) { delete this.scn.ast[axis]; this.src[axis] = ""; if (this.scn.kind === "custom") this.ramp = 0; }
        return;
      }
      if (text === this.src[axis]) return;         // the same equation again: nothing changes, no new fade-in
      const r = parseExpr(text);
      if (r.err) {                                 // like the engine: never keep running an older equation than the
        const wasOn = this.scn.kind === "custom" && this.on;    // one the page shows: this axis becomes 0, and if
        delete this.scn.ast[axis]; this.src[axis] = "";          // it was driving the device, forces switch off
        if (wasOn) { this.on = false; this.ramp = 0; }
        this.setMsg((wasOn ? "forces off: " : "") + axis + " error: " + r.err);
        return;
      }
      this.scn.ast[axis] = r.ast; this.src[axis] = text; this.setMsg(axis + " = " + text);
      if (this.scn.kind === "custom") this.ramp = 0;
    } else if (p[0] === "rec") {
      if (p[1] === "start" && !this.rec) { this.rec = { label: (p.slice(2).join("_") || "experiment").replace(/[^\w-]/g, ""), rows: [], t0: this.tl, header: this.comment() }; this.setMsg("recording '" + this.rec.label + "'"); }
      else if (p[1] === "stop" && this.rec) {
        const d = new Date(), pad = n => String(n).padStart(2, "0");
        const name = `${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}__${this.rec.label}.csv`;
        this.recs.unshift({ name, csv: this.toCSV(this.rec), scenario: this.rec.header.split("\n")[1].replace("# scenario: ", ""), notes: "" });
        this.lastFile = name; this.rec = null; this.setMsg("recording saved");
      }
    } else if (p[0] === "sim") { this.drag = p.slice(1, 4).map(Number); this.dragUntil = this.tl + 1.5; }
  }
  comment() {
    const f = a => "[" + a.map(v => v.toFixed(6)).join(",") + "]";
    return `# myHAPLY lab recording, BROWSER SIMULATOR, 1000 Hz\n# scenario: kind=${this.scn.kind} xd=${f(this.tgt.xd)} rpy=${f(this.tgt.rpy)} k=${f(this.tgt.k)} b=${f(this.tgt.b)} fmax=${this.fmax}\n` +
      (this.scn.kind === "custom" ? `# expr: fx=${this.src.fx} ; fy=${this.src.fy} ; fz=${this.src.fz}\n` : "");
  }
  toCSV(rec) {
    const L = ["Robot NAME:BrowserSimulator", rec.header.trimEnd(), "Time(ms),Time(s),Unix_epoch(ns),X,Y,Z,VX,VY,VZ,f1,f2,f3,e1,e2,e3,ramp,loop_us,Index"];
    rec.rows.forEach((r, i) => L.push([(r[0] * 1000).toFixed(3), r[0].toFixed(6), 0, ...r.slice(1).map(v => +v.toFixed(7)), 0, i].join(",")));
    return L.join("\n") + "\n";
  }
  step() {
    const now = performance.now() / 1000 - this.t0;
    let n = Math.min(60, Math.round((now - this.tl) * 1000));
    const dt = 0.001, mv = (cur, tgt, m) => { const d = sub(tgt, cur), L = norm3(d); return L <= m ? tgt.slice() : cur.map((c, i) => c + d[i] * m / L); };
    const each = (cur, tgt, m) => cur.map((c, i) => c + clamp(tgt[i] - c, -m, m));
    while (n-- > 0) {
      this.tl += dt; const t = this.tl, s = this.scn;
      s.xd = mv(s.xd, this.tgt.xd, 0.1 * dt); s.k = each(s.k, this.tgt.k, 2000 * dt); s.b = each(s.b, this.tgt.b, 30 * dt); s.rpy = each(s.rpy, this.tgt.rpy, dt);
      this.fmaxNow = this.fmax < this.fmaxNow ? this.fmax : Math.min(this.fmax, this.fmaxNow + 2 * dt);
      const r = forceOf(s, this.x, this.v, t); this.e = r.e;
      let F = [0, 0, 0];
      if (this.on) {
        this.ramp = Math.min(1, this.ramp + dt);
        // cap first, fade second: then the fade-in really takes 1 s, however large the equation's force is
        F = r.F.slice(); const m = norm3(F);
        if (!Number.isFinite(m)) F = [0, 0, 0]; else if (m > this.fmaxNow) F = F.map(f => f * this.fmaxNow / m);
        F = F.map(f => f * this.ramp);
      } else this.ramp = 0;
      if (t < this.dragUntil && this.drag) this.hand = mv(this.hand, this.drag, 0.5 * dt);
      else { const w = 2 * Math.PI * 0.12; this.hand = mv(this.hand, [0.04 * Math.sin(w * t), 0.03 * Math.sin(2 * w * t), 0.02 * Math.cos(w * t)], 0.1 * dt); }
      const a = [0, 1, 2].map(i => (150 * (this.hand[i] - this.x[i]) - 6 * this.v[i] + F[i]) / 0.15);
      this.v = this.v.map((v, i) => v + a[i] * dt); this.x = this.x.map((x, i) => x + this.v[i] * dt); this.F = F;
      if (this.rec && this.rec.rows.length < 600000) this.rec.rows.push([t - this.rec.t0, ...this.x, ...this.v, ...F, ...this.e, this.ramp]);
    }
    return this.state();
  }
  state() {
    return { t: this.tl, x: this.x, v: this.v, f: this.F, e: this.e, cal: true, connected: true, sim: true, on: this.on, ramp: this.ramp,
      hz: 1000, rt_us: 0, err: 0, rec: !!this.rec, rec_s: this.rec ? this.tl - this.rec.t0 : 0, rec_label: this.rec ? this.rec.label : "",
      last_file: this.lastFile, dev: "browser simulator", msg: this.msg, msg_id: this.msg_id,
      par: { kind: this.scn.kind, xd: this.tgt.xd, rpy: this.tgt.rpy, k: this.tgt.k, b: this.tgt.b, fmax: this.fmax,
        xd_now: this.scn.xd, k_now: this.scn.k, rpy_now: this.scn.rpy, fmax_now: this.fmaxNow, ...this.src },
      control: { holder: "you", you: true, watching: 1, names: [] } };
  }
}

// =========================================================================================== connection
const params = new URLSearchParams(location.search);
const VIEW_TV = params.get("view") === "tv";
const URL_KEY = params.get("key") || "";
// A ?key=... link is used for this page and removed from the address bar. connect() asks the server what kind of
// key it is: a lab (control) key is remembered as this browser's key; a watch-only key is remembered separately
// and never replaces a lab key already kept here (an instructor testing a watch link keeps driving rights).
// The big-screen view (?view=tv) uses its key for that page only.
if (URL_KEY && !VIEW_TV) {
  params.delete("key"); history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : "") + location.hash);
}
const KEY = () => URL_KEY || store.get("key", "") || store.get("viewkey", "");
// A new client id for every page load. (It used to be kept in sessionStorage, but browsers copy that into a
// duplicated tab: both tabs then counted as the driver, and closing one of them no longer stopped the forces.)
const CLIENT = (() => {
  try { const b = new Uint8Array(8); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); }
  catch { return Math.random().toString(36).slice(2, 12) + Date.now().toString(36); }
})();

const app = { mode: "connecting", hello: null, S: null, sim: null, lastMsgId: -1, es: null, files: null,
  lastStateAt: 0, streamStart: 0, lastPingOk: 0,     // to notice a lost connection
  exprSent: {}, exprSentAt: {}, exprError: {},       // the equations last sent to the engine, and the ones it refused
  pendingTry: null };                                 // a Try-it link waiting for "Take control"
const live = () => app.mode === "live";
// A watch-only link (the lab's "view key"): watch, read the code, press Stop forces, but never drive.
const viewOnly = () => live() && !!app.hello && app.hello.role === "view";

async function api(path, body) {
  const opt = { headers: { "X-Lab-Key": KEY() } };
  if (body !== undefined) { opt.method = "POST"; opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify({ client: CLIENT, name: myName(), ...body }); }
  const r = await fetch("api/" + path + (path.includes("?") ? "&" : "?") + "client=" + CLIENT, opt);
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error((j && j.error) || r.statusText), { status: r.status, body: j });
  return j;
}

async function connect() {
  try {
    const r = await fetch("api/hello?client=" + CLIENT, { headers: { "X-Lab-Key": KEY() } });
    if (r.status === 403) { app.mode = "needkey"; return; }
    if (!r.ok) throw new Error("no server");
    app.hello = await r.json(); app.mode = "live";
    if (URL_KEY && !VIEW_TV) store.set(app.hello.role === "control" ? "key" : "viewkey", URL_KEY);
  } catch { app.mode = "sim"; }
}

function startStream() {
  app.streamStart = performance.now();
  if (live()) {
    const open = () => {
      app.es = new EventSource("api/stream?key=" + encodeURIComponent(KEY()) + "&client=" + CLIENT);
      app.es.onmessage = ev => {
        let s; try { s = JSON.parse(ev.data); } catch { return; }
        app.lastStateAt = performance.now();
        onState(s);
      };
      app.es.onerror = () => { app.es.close(); setTimeout(open, 1500); };
    };
    open();
    setInterval(() => api("ping", {}).then(c => { app.lastPingOk = performance.now(); if (app.S) app.S.control = c; noteControl(); renderChips(); }).catch(() => {}), 400);
    setInterval(watchConnection, 300);
  } else {
    app.sim = new LocalSim();
    send(presetCommands(true));                            // start the simulator with the page's saved settings
    const tick = () => { onState(app.sim.step()); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
}
// No stream message for 1.5 s, or a state the engine sent more than 1 s ago (the server keeps re-sending the
// last one, about once a second, with its "age"): the page no longer knows what the device is doing.
function staleInfo() {
  if (!live()) return null;
  const quiet = (performance.now() - Math.max(app.lastStateAt, app.streamStart)) / 1000;
  if (quiet > 1.5) return { why: "server", secs: quiet };
  const age = app.S && app.S.age;
  if (typeof age === "number" && age > 1) return { why: "engine", secs: age };
  return null;
}

// The lab server's whitelist (CMD_PATTERNS in lab/haply_lab.py), checked here as well: the server refuses the
// whole batch if one command does not match, so a bad value (say, Infinity from a broken link) must not leave the page.
const FLOAT = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const CMD_OK = [/^forces [01]$/, /^set kind (free|impedance|wall|custom)$/, new RegExp(`^set (xd|rpy|k|b) ${FLOAT} ${FLOAT} ${FLOAT}$`),
  new RegExp(`^set fmax ${FLOAT}$`), /^expr (fx|fy|fz) [ -~]{0,240}$/, /^rec (start [A-Za-z0-9 _-]{0,60}|stop)$/,
  new RegExp(`^sim ${FLOAT} ${FLOAT} ${FLOAT}$`)];
// Sends commands to the engine (or to the browser simulator). Resolves to true only if they were all accepted,
// so a caller can tell, for example "only switch forces on if the new settings arrived".
function send(cmds) {
  if (!Array.isArray(cmds)) cmds = [cmds];
  const failed = m => { app.lastSendError = m; toast(m, "bad"); return false; };
  const bad = cmds.find(c => typeof c !== "string" || !CMD_OK.some(re => re.test(c)));
  if (bad !== undefined) return Promise.resolve(failed("not sent, this command is not allowed: " + bad));
  const sent = () => {                                   // remember which equations the engine has now
    cmds.forEach(c => { const m = /^expr (f[xyz]) (.*)$/.exec(c); if (m) { app.exprSent[m[1]] = m[2]; app.exprSentAt[m[1]] = performance.now(); } });
    return true;
  };
  if (!live()) { cmds.forEach(c => app.sim.handle(c)); return Promise.resolve(sent()); }
  return api("cmd", { cmds }).then(sent, e => failed(e.message));
}
// "Stop forces": anyone may press it, the driver or a watcher. POST api/stop takes the lab key or the watch-only
// key and needs no control, so the instructor can always stop a student's experiment from another laptop.
async function stopForces() {
  toastHoldUntil = 0;
  if (!live()) { app.sim.handle("forces 0"); return; }
  try { await api("stop", {}); toast("Stop sent: the forces switch off.", "good"); }
  catch (e) {
    if (e.status === 404 && inControl() && (await send("forces 0"))) return;   // an older lab server without api/stop
    toast(`The stop did not reach the lab (${e.message}). If the handle still pushes, switch off the motor power.`, "bad");
  }
}
const inControl = () => !live() || !!(app.S && app.S.control && app.S.control.you);
const myName = () => ($("#my-name").value || "").trim();

// =========================================================================================== state + chips
const trail = { top: [], n: 0 };
const BAD_MSG = /off:|cannot|lost|unknown|error|not allowed|refused|rejected/i;
function onState(s) {
  const prev = app.S;
  app.S = s;
  if (s.msg_id !== undefined && s.msg_id !== app.lastMsgId) {
    if (app.lastMsgId >= 0 && s.msg) {
      // "fx error: ..." (or "forces off: fx error: ...") is the engine refusing an equation: that axis is then 0;
      // "fx = ..." is it taking one
      const ex = /^(?:forces off: )?(f[xyz])( error: | = )/.exec(s.msg), refused = !!ex && ex[2] === " error: ";
      if (refused) app.exprError[ex[1]] = s.msg; else if (ex) delete app.exprError[ex[1]];
      const bad = refused || BAD_MSG.test(s.msg);
      if (bad || performance.now() > toastHoldUntil) toast(s.msg, bad ? "bad" : "info");
      if (/^forces off:/.test(s.msg)) app._forceConfirmed = false;      // after a safety cut-off, the checklist again
    }
    app.lastMsgId = s.msg_id;
  }
  // the device came or went, or lost its calibration: the next "switch on" asks for the checklist again
  if (prev && (prev.connected !== s.connected || prev.released !== s.released || (prev.cal && !s.cal))) app._forceConfirmed = false;
  if (s.x && s.cal) { trail.top.push(s.x.slice()); if (trail.top.length > 150) trail.top.shift(); }
  noteControl();
  resolvePendingHere(s);
  if (s.par) adoptEngineParams(s.par);
  frame();
}
// On every state and ping: notice when this page gains or loses control.
function noteControl() {
  if (!live()) return;
  const you = !!(app.S && app.S.control && app.S.control.you);
  if (app._wasYou && !you) {
    if (performance.now() - (app._tookAt || 0) < 1500) return;  // a state or ping sent just before our "take": ignore it
    app._forceConfirmed = false; app._adopted = false;          // whoever drives next starts with the checklist again
    if (!app._releasing) toast("You are no longer in control of the device (control was released, or this page was quiet for 3 s).", "bad", 4000);
  }
  if (app._wasYou !== you) { app._releasing = false; app._wasYou = you; renderPresetUI(); }
  checkPendingTry();
}

let lastChips = 0;
function renderChips() {
  const s = app.S || {};
  const c = s.control || {};
  const st = staleInfo();
  const chips = [];
  const chip = (cls, text) => chips.push(h("span", { class: "chip " + cls }, h("i"), text));
  if (st) chip("bad", st.why === "server" ? "connection lost" : "no data from the engine");
  if (app.mode === "needkey") chip("bad", "needs the lab key");
  else if (!live()) chip("warn", "simulator (no device)");
  else if (s.sim) chip("warn", "lab engine: simulator");
  else if (s.released) chip("warn", "device released to a program");
  else chip(s.connected ? "good" : "bad", s.connected ? "Inverse3 #" + s.dev : "no device");
  if (live() && s.connected && !s.sim && !s.released) chip(s.cal ? "good" : "bad", s.cal ? "calibrated" : "NOT calibrated");
  if (st) chip("bad", "forces: unknown");
  else chip(s.on ? "good" : "", s.on ? `forces ON${s.ramp < 1 ? " " + Math.round(s.ramp * 100) + "%" : ""}` : "forces off");
  if (s.hz && !st) chip("", Math.round(s.hz) + " Hz");
  if (live()) chip(c.you ? "good" : c.holder ? "warn" : "", c.you ? "you are in control" : c.holder ? "in control: " + c.holder : "nobody in control");
  if (viewOnly()) chip("", "watch-only link");
  if (live() && c.watching) chip("", c.watching + " watching");
  if (s.rec) chip("rec", "REC " + fmt(s.rec_s, 1) + " s");
  if (live() && s.auth === false) chip("warn", "engine without a command token (developer mode)");
  if (typeof s.space_mb === "number" && s.space_mb >= 0 && s.space_mb < 500) chip(s.space_mb < 100 ? "bad" : "warn", `disk: ${Math.round(s.space_mb)} MB free`);
  if (live() && !st && app.lastPingOk && performance.now() - app.lastPingOk > 2500) chip("bad", "server not answering");
  $("#chips").replaceChildren(...chips);
  const btn = $("#control-btn");
  btn.classList.toggle("hidden", !live() || viewOnly());
  btn.textContent = c.you ? "Release control" : "Take control";
  btn.classList.toggle("primary", !c.you);
  // Stop forces: for everyone, whenever forces are on, and whenever the page cannot tell (connection lost)
  $("#btn-stop").classList.toggle("hidden", !(s.on || st));
}
function renderConnBanner() {
  const st = staleInfo(), b = $("#conn-banner");
  b.classList.toggle("hidden", !st);
  if (!st) return;
  const t = st.secs > 90 ? "more than a minute" : Math.round(st.secs) + " s";
  b.textContent = (st.why === "server" ? `Connection lost: no news from the lab server for ${t}.` : `Connection lost: the lab engine has sent nothing for ${t}.`) +
    " Everything on this page is out of date, and forces cannot be switched on. If the handle pushes, press Stop forces, or switch off the motor power.";
}
// Three times a second in the lab. When the stream stops, nothing else redraws the page, so this does.
function watchConnection() {
  const st = staleInfo();
  if (st || !!st !== app._wasStale) { renderChips(); if (app.S && currentTab === "play") renderForceButton(app.S); }
  app._wasStale = !!st;
  renderConnBanner();
  checkPendingTry(); renderPendingTry();
}

$("#btn-stop").addEventListener("click", stopForces);
$("#control-btn").addEventListener("click", async () => {
  const c = (app.S && app.S.control) || {};
  if (c.you) { app._releasing = true; await api("control", { action: "release" }).catch(e => { app._releasing = false; toast(e.message, "bad"); }); return; }
  if (viewOnly()) { toast("This is a watch-only link. To drive the device, open the full lab link from your instructor.", "bad"); return; }
  if (!myName()) {
    const inp = h("input", { type: "text", placeholder: "First name", maxlength: "40" });
    const ok = await modal("Your name", h("div", {}, h("p", { class: "note", text: "Shown to others while you drive the device." }), inp),
      [{ label: "Cancel", value: false }, { label: "OK", cls: "primary", value: true }]);
    if (!ok || !inp.value.trim()) return;
    $("#my-name").value = inp.value.trim(); store.set("name", inp.value.trim());
  }
  const pt = app.pendingTry;
  try { await api("control", { action: "take" }); }
  catch (e) { toast(e.status === 409 ? `${(e.body && e.body.holder) || "Someone"} is driving the device right now. Ask them to release control.` : e.message, "bad"); return; }
  if (app.S) app.S.control = { ...(app.S.control || {}), you: true, holder: myName() };
  app._wasYou = true; app._tookAt = performance.now();
  app._forceConfirmed = false;                       // every turn at the device starts with the safety checklist
  app.exprSent = {}; app.exprSentAt = {};            // send the whole scenario once, whatever this page sent before
  app.pendingTry = null;
  renderPresetUI(); renderPendingTry();
  // Forces still on from the previous driver: you have not confirmed the checklist, so they go off first.
  let off = "";
  if ((app.S || {}).on && (await send("forces 0"))) off = " Forces were still on from the previous driver, so they were switched off.";
  if (pt && performance.now() - pt.at <= TRY_WAIT_MS) {          // load what a Try-it link set up
    const { next, label, note, herePending } = tryToP(pt);
    Object.assign(P, next);
    app.xdHerePending = herePending;
    app._adopted = true; userEditedAt = performance.now();
    store.set("P", P); renderEquation(); renderPresetUI();
    if (P.preset === "custom") syncEqInputs();
    if (await send(presetCommands(true))) toast(`You are in control. Loaded: ${label}.${note}${off} Switch forces on when you are holding the handle.`, note ? "bad" : "info", 5000);
    else { app._adopted = false; toast(`You are in control, but the device did not accept “${label}” (${app.lastSendError}). It keeps its previous settings, which this page shows again in a few seconds.`, "bad", 5000); }
  } else {
    app._adopted = false;                            // show what the engine is running now
    toast("You are in control. Others can watch." + off, "info", off ? 5000 : 0);
  }
});
$("#my-name").value = store.get("name", "");
// a new name means a new person at the device, who confirms the checklist for themselves
$("#my-name").addEventListener("change", e => { store.set("name", e.target.value.trim()); app._forceConfirmed = false; });

// =========================================================================================== tabs + routing
const TABS = ["start", "play", "experiment", "learn", "code", "eqlab", "report", "terminal", "feedback", "build"];
let currentTab = "start";
function showTab(name) {
  if (!TABS.includes(name)) name = "start";
  currentTab = name;
  $$("section.tab").forEach(s => s.classList.toggle("hidden", s.id !== "tab-" + name));
  $$("#tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  const init = { learn: initLearn, code: initCode, experiment: refreshRecordings, terminal: initTerminal, feedback: refreshFeedback, eqlab: eqUpdate, report: renderReport };
  if (init[name]) init[name]();
  if (name === "play") resizeCanvases();
  window.scrollTo(0, 0);
}
$$("#tabs button").forEach(b => b.addEventListener("click", () => { location.hash = "tab=" + b.dataset.tab; }));
function route() {
  const hp = new URLSearchParams(location.hash.slice(1));
  if (hp.has("try")) { applyTry(hp); return; }
  if (hp.has("lesson")) { showTab("learn"); openLesson(hp.get("lesson")); return; }
  showTab(hp.get("tab") || currentTab);
}
window.addEventListener("hashchange", route);

// =========================================================================================== play: parameters
const PRESETS = {
  free:      { label: "Free", help: "No force. Move around and watch the numbers: this is what 01_read_fbk prints." },
  spring:    { label: "Spring to a point", help: "Impedance control at x_d: a spring (k) pulls you to the target, a damper (b) resists speed. K = diag(k,k,k)." },
  line:      { label: "Line guide", help: "A virtual fixture: free to slide along the frame's z axis, pulled onto that line. K = diag(k,k,0). Rotate it with roll/pitch/yaw." },
  plane:     { label: "Plane guide", help: "Free to move in a plane, pulled onto it. K = diag(0,0,k). The plane passes through x_d; its normal is the frame's z axis." },
  wall:      { label: "Wall", help: "A one-sided spring: pushes you out when you go through the plane, never pulls you in. Normal = frame z axis." },
  damping:   { label: "Damping field", help: "No spring, only damping: moving fast feels like moving through honey. F = −B v." },
  custom:    { label: "My equation", help: "The force comes from the equations you wrote in the Equation lab." },
};
const isPreset = p => typeof p === "string" && Object.prototype.hasOwnProperty.call(PRESETS, p);
const P_DEFAULT = { preset: "free", k: 200, b: 2, fmax: 2, xd: [0, 0, 0], rpy: [0, 0, 0], fx: "-kx*(x - xd) - bx*vx", fy: "-ky*(y - yd) - by*vy", fz: "-kz*(z - zd) - bz*vz" };
// The page's settings, kept in this browser. Every value is checked when it is read back, inside the slider
// ranges: a broken value (from an old version of the page, or a bad link) must never stop the page or reach the device.
function sanitizeP(p) {
  p = p && typeof p === "object" ? p : {};
  const D = P_DEFAULT, n = (v, lo, hi, d) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : d);
  const v3 = (v, lo, hi) => (Array.isArray(v) && v.length === 3 ? v.map(x => n(x, lo, hi, 0)) : [0, 0, 0]);
  const eq = (v, d) => (typeof v === "string" && !parseExpr(v.trim() || "0").err ? v.trim() || "0" : d);
  return { preset: isPreset(p.preset) ? p.preset : D.preset, k: n(p.k, 0, 800, D.k), b: n(p.b, 0, 10, D.b), fmax: n(p.fmax, 0.5, 4, D.fmax),
    xd: v3(p.xd, -0.3, 0.3), rpy: v3(p.rpy, -180, 180), fx: eq(p.fx, D.fx), fy: eq(p.fy, D.fy), fz: eq(p.fz, D.fz) };
}
const P = sanitizeP(store.get("P", {}));
let userEditedAt = 0;

const kindOf = preset => ({ free: "free", wall: "wall", custom: "custom" }[preset] || "impedance");
const exprText = v => String(v || "").trim() || "0";     // what is sent for one equation box
const exprNorm = t => (t === "0" ? "" : String(t));       // the engine reports a cleared ("0") equation as ""
// The page's scenario as engine commands. In "My equation" mode the expr commands go only for equations that
// changed (or that the engine shows differently): a new equation restarts the fade-in, and dragging a slider must
// not do that. all = true sends everything: on "Take control" and just before "switch on".
function presetCommands(all) {
  const K = P.k, B = P.b;
  const kb = { spring: [[K, K, K], [B, B, B]], line: [[K, K, 0], [B, B, 0]], plane: [[0, 0, K], [0, 0, B]], wall: [[0, 0, K], [0, 0, B]],
    damping: [[0, 0, 0], [B, B, B]], custom: [[K, K, K], [B, B, B]], free: [[0, 0, 0], [0, 0, 0]] }[P.preset];
  const c = [`set kind ${kindOf(P.preset)}`, `set k ${kb[0].join(" ")}`, `set b ${kb[1].join(" ")}`,
    `set xd ${P.xd.map(v => v.toFixed(5)).join(" ")}`, `set rpy ${P.rpy.map(v => rad(v).toFixed(5)).join(" ")}`, `set fmax ${P.fmax}`];
  if (P.preset === "custom") c.push(...exprCommands(all));
  return c;
}
function exprCommands(all) {
  const par = (live() ? app.S && app.S.par : app.sim && app.sim.state().par) || {};
  return ["fx", "fy", "fz"].filter(a => {
    const want = exprText(P[a]);
    if (all || want !== app.exprSent[a]) return true;
    // sent before, but the engine runs something else (it restarted, or another driver changed it): send it again
    return typeof par[a] === "string" && exprNorm(par[a]) !== exprNorm(want) && performance.now() - (app.exprSentAt[a] || 0) > 1500;
  }).map(a => `expr ${a} ${exprText(P[a])}`);
}
let sendTimer;
function pushParams() {
  store.set("P", P); userEditedAt = performance.now();
  renderEquation(); renderPresetUI();
  if (!inControl()) return;
  // if the server refuses the batch, stop trusting the page's numbers: show the engine's real ones again
  clearTimeout(sendTimer); sendTimer = setTimeout(async () => { if (!(await send(presetCommands()))) app._adopted = false; }, 60);
}
function adoptEngineParams(par) {
  // While someone else drives (or just after taking control) show what the engine is really doing.
  if (!live()) return;                                  // the browser simulator follows the page, not the reverse
  if (inControl() && performance.now() - userEditedAt < 4000) return;
  if (inControl() && app._adopted) return;
  const k = par.k || [0, 0, 0], b = par.b || [0, 0, 0];
  let preset = par.kind === "wall" ? "wall" : par.kind === "custom" ? "custom" : par.kind === "free" ? "free" : "spring";
  if (par.kind === "impedance") {
    if (k[0] === 0 && k[1] === 0 && k[2] === 0) preset = "damping";
    else if (k[2] === 0 && k[0] > 0) preset = "line";
    else if (k[0] === 0 && k[1] === 0) preset = "plane";
  }
  const before = JSON.stringify([P.preset, P.k, P.b, P.fmax, P.xd, P.rpy.map(Math.round), P.fx, P.fy, P.fz]);
  P.preset = preset; P.k = Math.max(...k) || P.k; P.b = Math.max(...b) || (preset === "free" ? P.b : 0); P.fmax = par.fmax || P.fmax;
  P.xd = par.xd || P.xd; P.rpy = (par.rpy || [0, 0, 0]).map(deg);
  // the equations the engine reports are the ones it compiled and runs ("" = cleared, i.e. 0)
  if (par.kind === "custom") ["fx", "fy", "fz"].forEach(a => { if (typeof par[a] === "string") P[a] = par[a] || "0"; });
  if (inControl()) {
    app._adopted = true;
    // what the engine runs now counts as sent, so the next slider move does not resend (and restart) the equations
    if (par.kind === "custom") ["fx", "fy", "fz"].forEach(a => { if (typeof par[a] === "string") { app.exprSent[a] = exprText(P[a]); app.exprSentAt[a] = performance.now(); } });
  }
  if (JSON.stringify([P.preset, P.k, P.b, P.fmax, P.xd, P.rpy.map(Math.round), P.fx, P.fy, P.fz]) !== before) { renderPresetUI(); renderEquation(); }
}

const SLIDERS = [
  { id: "k", label: "Stiffness k", unit: "N/m", min: 0, max: 800, step: 10, help: "1 cm away at k = 300 N/m gives 3 N" },
  { id: "b", label: "Damping b", unit: "N·s/m", min: 0, max: 10, step: 0.1 },
  { id: "fmax", label: "Force limit", unit: "N", min: 0.5, max: 4, step: 0.1 },
  { id: "roll", label: "Roll", unit: "°", min: -180, max: 180, step: 1 },
  { id: "pitch", label: "Pitch", unit: "°", min: -180, max: 180, step: 1 },
  { id: "yaw", label: "Yaw", unit: "°", min: -180, max: 180, step: 1 },
];
function sliderValue(id) { return id === "roll" ? P.rpy[0] : id === "pitch" ? P.rpy[1] : id === "yaw" ? P.rpy[2] : P[id]; }
function buildPlayControls() {
  const pr = $("#presets");
  Object.entries(PRESETS).forEach(([k, v]) => pr.append(h("button", { type: "button", "data-p": k, onclick: () => {
    P.preset = k;
    if (k !== "free" && P.k === 0 && k !== "damping") P.k = 200;
    if (k === "custom") toast("Edit the equations in the Equation lab tab.");
    pushParams();
  } }, v.label)));
  const sl = $("#sliders");
  SLIDERS.forEach(s => {
    const inp = h("input", { type: "range", min: s.min, max: s.max, step: s.step, id: "sl-" + s.id, "aria-label": s.label });
    const val = h("span", { class: "v", id: "slv-" + s.id });
    inp.addEventListener("input", () => {
      const v = +inp.value;
      if (s.id === "roll") P.rpy[0] = v; else if (s.id === "pitch") P.rpy[1] = v; else if (s.id === "yaw") P.rpy[2] = v; else P[s.id] = v;
      pushParams();
    });
    sl.append(h("div", { class: "slider" }, h("span", { title: s.help || "" }, s.label), inp, val));
  });
  ["x", "y", "z"].forEach((a, i) => $("#xd-" + a).addEventListener("change", e => {
    const v = e.target.value.trim() === "" ? NaN : +e.target.value;
    if (!Number.isFinite(v)) { e.target.value = Math.round(P.xd[i] * 1000); toast("The target needs a number in millimetres.", "bad"); return; }
    app.xdHerePending = false;                                    // a target typed by hand wins over a waiting "here"
    P.xd[i] = clamp(v, -300, 300) / 1000; pushParams();          // the engine keeps x_d within ±300 mm too
  }));
  $("#btn-xd-here").addEventListener("click", () => {
    const s = app.S || {};
    if (!s.cal || !vec3(s.x)) { toast("The device is not calibrated yet, so there is no cursor position to use.", "bad"); return; }
    app.xdHerePending = false;
    P.xd = s.x.map(v => clamp(v, -0.3, 0.3)); pushParams(); toast("Target placed at the cursor.");
  });
  $("#btn-forces").addEventListener("click", toggleForces);
  $("#btn-center").addEventListener("click", () => { if (app.S) viewState.c = app.S.x.slice(); });
  $("#btn-zoom-in").addEventListener("click", () => (viewState.half = Math.max(0.02, viewState.half / 1.5)));
  $("#btn-zoom-out").addEventListener("click", () => (viewState.half = Math.min(0.4, viewState.half * 1.5)));
  $("#btn-open-code").addEventListener("click", () => { location.hash = "tab=code"; setTimeout(() => openFile("libs/myHAPLY_SCENARIOS.h"), 50); });
  // The big screen only watches, so its link carries the watch-only key (the lab server gives it to key holders).
  const viewKey = app.hello && app.hello.view_key;
  const tvUrl = live() ? `${location.origin}/?key=${encodeURIComponent(viewKey || KEY())}&view=tv` : `${location.pathname}?view=tv`;
  $("#lnk-tv").href = tvUrl;
  $("#btn-viewlink").classList.toggle("hidden", !viewKey);
  if (viewKey) $("#btn-viewlink").addEventListener("click", e => copy(`${location.origin}/?key=${encodeURIComponent(viewKey)}`, e.currentTarget));
  $("#btn-tv").addEventListener("click", async () => {
    if (!live() || !app.hello || !app.hello.tv) { toast("The lab TV can only be used from the lab console on the Pi.", "bad"); return; }
    const v = await modal("Show this on the lab TV?", h("p", { text: "The TV switches to the Pi's input (HDMI 1) and shows the big-screen view: both views, the equation and the force. Only do this if nobody else is using the TV right now." }),
      [{ label: "Cancel", value: 0 }, { label: "Put the TV back to the clock", value: 2 }, { label: "Show it on the TV", cls: "primary", value: 1 }]);
    if (!v) return;
    try { await api("tv", { action: v === 1 ? "show" : "off" }); toast(v === 1 ? "Showing on the lab TV (takes a few seconds)." : "The TV shows the clock again."); }
    catch (e) { toast("TV: " + e.message, "bad"); }
  });
}
function renderPresetUI() {
  $$("#presets button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.p === P.preset)));
  $("#preset-help").textContent = PRESETS[P.preset].help;
  SLIDERS.forEach(s => {
    const v = sliderValue(s.id), inp = $("#sl-" + s.id);
    if (document.activeElement !== inp) inp.value = v;
    $("#slv-" + s.id).textContent = `${s.step < 1 ? (+v).toFixed(1) : Math.round(v)} ${s.unit}`;
  });
  ["x", "y", "z"].forEach((a, i) => { const e = $("#xd-" + a); if (document.activeElement !== e) e.value = Math.round(P.xd[i] * 1000); });
  const ctl = inControl();
  $$("#tab-play input, #presets button").forEach(e => { if (e.id !== "chk-place") e.disabled = !ctl; });
  $("#btn-xd-here").disabled = !ctl;
}

// Why forces cannot be switched on right now ("" if they can). The engine checks the same things itself.
function forcesBlocked(s) {
  if (viewOnly()) return "This is a watch-only link: you can watch and stop the forces, but not switch them on.";
  if (!inControl()) return "Take control first (button at the top right).";
  if (staleInfo()) return "There is no live data from the lab right now, so forces cannot be switched on.";
  if (live() && !s.sim) {
    if (s.released) return "The device is released to a terminal program. Press “Give the device back to the console” in the Terminal tab first.";
    if (!s.connected) return "No device is connected: check the blue USB cable on the Pi, then wait a few seconds.";
    if (!s.cal) return "Calibrate the device first: rest the cursor on the magnetic dock until the LED changes colour.";
  }
  return "";
}
// Does the engine run the scenario this page shows? (kind, and in "My equation" mode the three equations)
function engineMatchesP() {
  const s = live() ? app.S : app.sim && app.sim.state();
  const par = s && s.par;
  if (!par || par.kind === undefined) return true;              // an older engine that does not report its settings
  if (par.kind !== kindOf(P.preset)) return false;
  return P.preset !== "custom" || ["fx", "fy", "fz"].every(a => typeof par[a] !== "string" || exprNorm(par[a]) === exprNorm(exprText(P[a])));
}
async function engineMatches(ms) {                               // wait up to ms for the state to show it
  const t0 = performance.now();
  while (!engineMatchesP()) {
    if (performance.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 50));
  }
  return true;
}
async function toggleForces() {
  const s = app.S || {};
  toastHoldUntil = 0;                                            // a new action: the engine's answers may show again
  if (s.on) { stopForces(); return; }                           // anyone may switch forces off
  if (app._switchingOn) return;
  const why = forcesBlocked(s);
  if (why) { toast(why, "bad"); return; }
  if (live() && !s.sim && !app._forceConfirmed) {               // asked again every time control is taken
    const boxes = ["The motor power cable is plugged in (feedback works without it; forces need it).",
      "I am holding the handle firmly.", "Nobody's face or fingers are near the arms.",
      "I know: the red “Stop forces” button at the top of the page (or closing the page) switches forces off within 2 s."].map(t => h("label", {}, h("input", { type: "checkbox" }), h("span", { text: t })));
    const body = h("div", {}, ...boxes);
    const ok = await modal("Before forces go on", body, [{ label: "Cancel", value: false },
      { label: "Switch forces on", cls: "primary", value: true, check: () => { const all = $$("input", body).every(c => c.checked); if (!all) toast("Tick all four boxes first.", "bad"); return all; } }]);
    if (!ok) return;
  }
  app._switchingOn = true;
  try {
    // First the scenario, and only once it has arrived, "forces 1". Otherwise a refused batch (a bad value) would
    // switch on whatever the engine still had from before: another student's scenario.
    const again = () => forcesBlocked(app.S || {});              // things may have changed while we waited
    if (again()) { toast(again(), "bad"); return; }
    clearTimeout(sendTimer);                                      // this batch replaces a pending slider update
    if (!(await send(presetCommands(true)))) { toast(`These settings were not accepted (${app.lastSendError}), so forces stay off.`, "bad"); return; }
    if (!(await engineMatches(1500))) {
      const m = (app.S && app.S.msg) || "";
      toast(`The device has not taken these settings${m ? ` (its last message: “${m}”)` : ""}, so forces stay off.`, "bad"); return;
    }
    if (again()) { toast(again(), "bad"); return; }
    if (await send("forces 1")) app._forceConfirmed = live() && !s.sim;   // until control changes hands or something cuts out
  } finally { app._switchingOn = false; }
}

// =========================================================================================== play: views
const viewState = { c: [0, 0, 0], half: 0.12 };
let canvases = [];
function resizeCanvases() {
  canvases = VIEW_TV ? [[$("#tv-top"), [0, 1]], [$("#tv-side"), [0, 2]]] : [[$("#cv-top"), [0, 1]], [$("#cv-side"), [0, 2]]];
  canvases.forEach(([cv]) => { const r = cv.getBoundingClientRect(); const d = window.devicePixelRatio || 1;
    if (r.width > 0) { cv.width = Math.round(r.width * d); cv.height = Math.round(r.width * d); } });
}
window.addEventListener("resize", () => resizeCanvases());

function drawView(cv, ax, s) {
  const g = cv.getContext("2d"), W = cv.width, H = cv.height;
  const [a, b] = ax, half = viewState.half, sc = W / (2 * half), c = viewState.c;
  const X = p => W / 2 + (p[a] - c[a]) * sc, Y = p => H / 2 - (p[b] - c[b]) * sc;
  g.fillStyle = css("--surface-1"); g.fillRect(0, 0, W, H);
  // grid: 1 cm and 5 cm
  [[0.01, css("--grid")], [0.05, css("--grid-major")]].forEach(([step, col]) => {
    g.strokeStyle = col; g.lineWidth = 1; g.beginPath();
    for (let v = Math.ceil((c[a] - half) / step) * step; v <= c[a] + half; v += step) { const px = W / 2 + (v - c[a]) * sc; g.moveTo(px, 0); g.lineTo(px, H); }
    for (let v = Math.ceil((c[b] - half) / step) * step; v <= c[b] + half; v += step) { const py = H / 2 - (v - c[b]) * sc; g.moveTo(0, py); g.lineTo(W, py); }
    g.stroke();
  });
  const d = window.devicePixelRatio || 1;
  g.font = `${11 * d}px system-ui`; g.fillStyle = css("--text-muted");
  g.fillText("grid: 1 cm", 6 * d, H - 6 * d);
  if (!s || !s.x) return;
  const par = s.par || {};
  // Draw what the force really uses right now: the engine moves x_d (xd_now) and turns the frame (rpy_now) towards
  // the targets at a limited speed, so the drawn wall or line must not jump ahead of the one you feel.
  const rpy = vec3(par.rpy_now) || vec3(s.rpy_now) || vec3(par.rpy) || [0, 0, 0];
  const kind = par.kind || "free", xd = vec3(par.xd_now) || vec3(par.xd) || [0, 0, 0], R = R_from_rpy(rpy);
  const n = [R[0][2], R[1][2], R[2][2]];
  const accent = css("--accent"), f2 = css("--series-2"), muted = css("--text-muted");
  // scenario geometry
  g.lineWidth = 2 * d;
  if (kind !== "free" && s.cal) {
    const k = par.k || [0, 0, 0];
    const isLine = kind === "impedance" && k[2] === 0 && (k[0] > 0 || k[1] > 0);
    const isPlane = kind === "wall" || (kind === "impedance" && k[0] === 0 && k[1] === 0 && k[2] > 0);
    if (isLine) {
      g.strokeStyle = css("--series-3"); g.setLineDash([]); g.beginPath();
      g.moveTo(X(xd.map((v, i) => v - n[i])), Y(xd.map((v, i) => v - n[i]))); g.lineTo(X(xd.map((v, i) => v + n[i])), Y(xd.map((v, i) => v + n[i]))); g.stroke();
    }
    if (isPlane) {
      // trace of the plane n.(p - xd) = 0 in this view, at the cursor's third coordinate
      const o = 3 - a - b, na = n[a], nb = n[b], k0 = n[o] * (s.x[o] - xd[o]);
      g.strokeStyle = css("--series-3"); g.beginPath();
      if (Math.abs(nb) > 1e-6) { const yAt = u => xd[b] - (na * (u - xd[a]) + k0) / nb; const u0 = c[a] - half, u1 = c[a] + half;
        const p0 = [0, 0, 0], p1 = [0, 0, 0]; p0[a] = u0; p0[b] = yAt(u0); p1[a] = u1; p1[b] = yAt(u1); g.moveTo(X(p0), Y(p0)); g.lineTo(X(p1), Y(p1)); }
      else if (Math.abs(na) > 1e-6) { const u = xd[a] - k0 / na; const p0 = [0, 0, 0], p1 = [0, 0, 0]; p0[a] = p1[a] = u; p0[b] = c[b] - half; p1[b] = c[b] + half; g.moveTo(X(p0), Y(p0)); g.lineTo(X(p1), Y(p1)); }
      g.stroke();
      if (kind === "wall") { // normal arrow
        g.strokeStyle = muted; g.beginPath(); g.moveTo(X(xd), Y(xd)); const tip = xd.map((v, i) => v + n[i] * 0.02); g.lineTo(X(tip), Y(tip)); g.stroke();
        g.fillStyle = muted; g.fillText("outside", X(tip) + 4 * d, Y(tip));
      }
    }
    // target ring
    g.strokeStyle = muted; g.lineWidth = 2 * d; g.beginPath(); g.arc(X(xd), Y(xd), 7 * d, 0, 7); g.stroke();
    if (kind === "impedance" && !isPlane && !isLine && (par.k || [0])[0] > 0) { g.setLineDash([4 * d, 4 * d]); g.beginPath(); g.moveTo(X(xd), Y(xd)); g.lineTo(X(s.x), Y(s.x)); g.stroke(); g.setLineDash([]); }
  }
  // trail
  if (trail.top.length > 1) {
    g.strokeStyle = accent; g.globalAlpha = 0.35; g.lineWidth = 1.5 * d; g.beginPath();
    trail.top.forEach((p, i) => (i ? g.lineTo(X(p), Y(p)) : g.moveTo(X(p), Y(p)))); g.stroke(); g.globalAlpha = 1;
  }
  if (!s.cal) { g.fillStyle = css("--critical"); g.font = `${14 * d}px system-ui`; g.fillText("not calibrated: no position yet", 10 * d, 22 * d); return; }
  // force arrow: 1 N drawn as 2 cm
  const f = s.f || [0, 0, 0], fm = Math.hypot(f[a], f[b]);
  if (norm3(f) > 0.01) {
    const tip = s.x.map((v, i) => v + f[i] * 0.02);
    g.strokeStyle = f2; g.fillStyle = f2; g.lineWidth = 3 * d; g.beginPath(); g.moveTo(X(s.x), Y(s.x)); g.lineTo(X(tip), Y(tip)); g.stroke();
    if (fm > 0.01) { const ang = Math.atan2(-(tip[b] - s.x[b]), tip[a] - s.x[a]); g.beginPath(); g.moveTo(X(tip), Y(tip));
      g.lineTo(X(tip) - 10 * d * Math.cos(ang - 0.4), Y(tip) + 10 * d * Math.sin(ang - 0.4)); g.lineTo(X(tip) - 10 * d * Math.cos(ang + 0.4), Y(tip) + 10 * d * Math.sin(ang + 0.4)); g.fill(); }
  }
  // cursor
  g.fillStyle = accent; g.strokeStyle = css("--surface-1"); g.lineWidth = 2 * d; g.beginPath(); g.arc(X(s.x), Y(s.x), 7 * d, 0, 7); g.fill(); g.stroke();
  g.fillStyle = css("--text-muted"); g.font = `${11 * d}px system-ui`; g.fillText("arrow: 1 N = 2 cm", W - 112 * d, H - 6 * d);
}

function setupViewInput() {
  [["#cv-top", [0, 1]], ["#cv-side", [0, 2]]].forEach(([sel, [a, b]]) => {
    const cv = $(sel);
    const toWorld = ev => { const r = cv.getBoundingClientRect(); const u = (ev.clientX - r.left) / r.width, v = (ev.clientY - r.top) / r.height;
      const p = (app.S && app.S.x ? app.S.x : [0, 0, 0]).slice(); p[a] = viewState.c[a] + (u - 0.5) * 2 * viewState.half; p[b] = viewState.c[b] - (v - 0.5) * 2 * viewState.half; return p; };
    let down = false;
    cv.addEventListener("pointerdown", ev => {
      if ($("#chk-place").checked) { if (!inControl()) { toast("Take control first.", "bad"); return; } const p = toWorld(ev); P.xd[a] = clamp(p[a], -0.3, 0.3); P.xd[b] = clamp(p[b], -0.3, 0.3); pushParams(); return; }
      down = true; cv.setPointerCapture(ev.pointerId); dragTo(toWorld(ev));
    });
    cv.addEventListener("pointermove", ev => { if (down) dragTo(toWorld(ev)); });
    cv.addEventListener("pointerup", () => (down = false));
  });
}
let lastDrag = 0;
function dragTo(p) {
  const s = app.S || {};
  if (live() && !s.sim) return;          // a real device is moved by hand, not by the mouse
  if (performance.now() - lastDrag < 30) return; lastDrag = performance.now();
  if (live()) { if (inControl()) send(`sim ${p.map(v => v.toFixed(4)).join(" ")}`); } else app.sim.handle(`sim ${p.join(" ")}`);
}

// =========================================================================================== play: equation + numbers
function eqTex() {
  const kind = P.preset;
  if (kind === "free") return String.raw`\mathbf{F} = \mathbf{0}`;
  if (kind === "wall") return String.raw`d = \mathbf{n}^{\top}(\mathbf{x}_d - \mathbf{x}),\qquad \mathbf{F} = \begin{cases} \max\left(0,\ k\,d - b\,\mathbf{n}^{\top}\mathbf{v}\right)\mathbf{n} & d > 0 \\ \mathbf{0} & d \le 0 \end{cases}`;
  if (kind === "custom") {
    const rows = ["fx", "fy", "fz"].map(a => { const r = parseExpr(P[a] || "0"); return r.err ? "?" : toTex(r.ast); });
    return String.raw`\mathbf{F} = \begin{bmatrix} ${rows.join(" \\\\ ")} \end{bmatrix}`;
  }
  return String.raw`\mathbf{F} = \mathbf{R}\left(\mathbf{K}\,\mathbf{R}^{\top}(\mathbf{x}_d - \mathbf{x}) - \mathbf{B}\,\mathbf{R}^{\top}\mathbf{v}\right)`;
}
function eqParamsTex() {
  const K = P.k, B = P.b;
  const kb = { spring: [[K, K, K], [B, B, B]], line: [[K, K, 0], [B, B, 0]], plane: [[0, 0, K], [0, 0, B]], wall: [[0, 0, K], [0, 0, B]], damping: [[0, 0, 0], [B, B, B]] }[P.preset];
  const xd = String.raw`\mathbf{x}_d = (${P.xd.map(v => Math.round(v * 1000)).join(",\\ ")})\ \text{mm}`;
  const rpy = String.raw`(\text{roll},\text{pitch},\text{yaw}) = (${P.rpy.map(v => Math.round(v)).join("^\\circ,\\ ")}^\circ)`;
  if (!kb) return P.preset === "custom" ? String.raw`k = ${K}\ \text{N/m},\ b = ${B}\ \text{N·s/m},\ ${xd}` : "";
  if (P.preset === "wall") return String.raw`k = ${K}\ \text{N/m},\quad b = ${B}\ \text{N·s/m},\quad ${xd},\quad \mathbf{n} = \mathbf{R}\,\hat{\mathbf{z}},\quad ${rpy}`;
  return String.raw`\mathbf{K} = \operatorname{diag}(${kb[0].join(",")})\ \text{N/m},\quad \mathbf{B} = \operatorname{diag}(${kb[1].join(",")})\ \text{N·s/m},\quad ${xd},\quad ${rpy}`;
}
function renderEquation() {
  $("#eq-general").replaceChildren(tex(eqTex()));
  const pt = eqParamsTex();
  $("#eq-numbers").replaceChildren(pt ? tex(pt, false) : "");
  renderCodeSnippet();
  if (VIEW_TV) $("#tv-eq").replaceChildren(tex(eqTex()));
}
let scenSrc = null;
async function renderCodeSnippet() {
  if (scenSrc === null) { scenSrc = ""; scenSrc = (await loadSource("libs/myHAPLY_SCENARIOS.h")) || ""; }
  if (!scenSrc) { $("#eq-code").replaceChildren(h("p", { class: "note", text: "Could not load the source file." })); return; }
  const lines = scenSrc.split("\n");
  const marker = { free: "case Kind::Free:", wall: "case Kind::Wall:", custom: "case Kind::Custom:" }[P.preset] || "case Kind::Impedance:";
  const start = lines.findIndex(l => l.includes("inline Vec3 force("));
  const i = lines.findIndex(l => l.includes(marker));
  if (start < 0 || i < 0) return;
  let j = i + 1; while (j < lines.length && !/^\s*case Kind::|^\s*}\s*$/.test(lines[j])) j++;
  const head = lines.slice(start, start + 5).join("\n"), body = lines.slice(i, Math.min(j, i + 14)).join("\n");
  $("#eq-code").replaceChildren(codeBlock(head + "\n    ...\n" + body));
}

let lastNum = 0;
function renderReadout(s) {
  if (performance.now() - lastNum < 100) return; lastNum = performance.now();
  const row = (name, unit, v, f, extra) => [h("span", { class: "h", text: name }), ...[0, 1, 2].map(i => h("b", { text: v ? f(v[i]) : "–" })), h("span", { class: "h", text: unit + (extra || "") })];
  const F = s.f || [0, 0, 0];
  $("#readout").replaceChildren(
    h("span"), h("span", { class: "h", text: "x" }), h("span", { class: "h", text: "y" }), h("span", { class: "h", text: "z" }), h("span"),
    ...row("position", "mm", s.cal ? s.x : null, mm),
    ...row("velocity", "mm/s", s.cal ? s.v : null, mm),
    ...row("force", "N", F, v => fmt(v, 2), `  |F| = ${fmt(norm3(F), 2)} N`),
    ...row("error e = Rᵀ(x_d − x)", "mm", s.cal && (s.par || {}).kind !== "free" ? s.e : null, mm),
  );
  renderForceButton(s);
  $("#drag-hint").textContent = live() && !s.sim ? "Move the real handle." : "Drag in a view to move the virtual hand.";
  $("#scale-top").textContent = $("#scale-side").textContent = `±${Math.round(viewState.half * 100)} cm`;
}
// The big Forces button: anyone can switch forces off; switching on needs control, live data and a ready device.
function renderForceButton(s) {
  const btn = $("#btn-forces"), st = staleInfo(), why = s.on ? "" : forcesBlocked(s), par = s.par || {};
  btn.textContent = s.on ? "Forces are ON — switch off" : st ? "No live data — forces cannot go on" : "Forces are OFF — switch on";
  btn.className = "btn big forcebtn " + (s.on ? "danger" : "good");
  btn.disabled = !s.on && !!why;
  const lim = firstNum(par.fmax, P.fmax), now = firstNum(par.fmax_now, s.fmax_now);
  const rising = now !== null && now < lim - 0.05 ? ` (rising to it at 2 N/s, now ${fmt(now, 1)} N)` : "";
  $("#force-note").textContent = s.on ? (inControl() ? `Force limit ${fmt(lim, 1)} N${rising}. Closing this page also switches forces off within 2 s.`
      : `Force limit ${fmt(lim, 1)} N${rising}. You are watching: you can still switch the forces off, here or with Stop forces at the top.`) :
    why ? (inControl() || viewOnly() ? why : "Take control (top right) to change anything. You can still watch, and stop the forces.") :
    "Forces fade in over 1 s. Start with small k (100–200 N/m).";
}

function frame() {
  const s = app.S; if (!s) return;
  if (performance.now() - lastChips > 250) { renderChips(); lastChips = performance.now(); renderStartSteps(); renderActiveExpr(); }
  // keep the cursor in view
  if (s.cal && s.x) for (let i = 0; i < 3; i++) if (Math.abs(s.x[i] - viewState.c[i]) > viewState.half * 0.8) viewState.c[i] = s.x[i];
  if (currentTab === "play" || VIEW_TV) { canvases.forEach(([cv, ax]) => drawView(cv, ax, s)); if (!VIEW_TV) renderReadout(s); else renderTV(s); }
  if (currentTab === "experiment") renderRecStatus(s);
}

// =========================================================================================== try links
// A "Try it" link (#try=spring&k=300&b=2&xd=here&rpy=0,90,0) sets up the Play tab. Every value is checked first:
// a plain number inside the slider's range (k 0-800 N/m, b 0-10 N s/m, fmax 0.5-4 N, roll/pitch/yaw ±180°,
// x_d ±300 mm), and an equation the device would accept. A link without rpy means "not rotated" (0,0,0).
// xd=here means "at the cursor", read when the link actually loads, and only if the device is calibrated.
const TRY_WAIT_MS = 60000;                         // a link waits this long for "Take control"
const TRY_NUM = { k: [0, 800], b: [0, 10], fmax: [0.5, 4] };
const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
function parseTry(hp) {
  const preset = hp.get("try");
  if (!isPreset(preset)) return { err: `there is no behaviour called '${preset}'` };
  const t = { preset };
  const num = (name, text, lo, hi) => {
    const v = NUMBER_RE.test(text.trim()) ? +text : NaN;
    if (!Number.isFinite(v) || v < lo || v > hi) throw `${name} must be a number from ${lo} to ${hi} (the link says '${text}')`;
    return v;
  };
  const three = (name, text, lo, hi) => {
    const parts = text.split(",");
    if (parts.length > 3) throw `${name} takes at most three numbers (the link says '${text}')`;
    return parts.map(p => num(name, p, lo, hi)).concat([0, 0, 0]).slice(0, 3);
  };
  try {
    Object.entries(TRY_NUM).forEach(([n, [lo, hi]]) => { if (hp.has(n)) t[n] = num(n, hp.get(n), lo, hi); });
    t.rpy = hp.has("rpy") ? three("rpy (degrees)", hp.get("rpy"), -180, 180) : [0, 0, 0];
    if (hp.has("xd")) t.xd = hp.get("xd") === "here" ? "here" : three("xd (mm)", hp.get("xd"), -300, 300).map(v => v / 1000);
    ["fx", "fy", "fz"].forEach(a => {
      if (!hp.has(a)) return;
      const src = hp.get(a).trim() || "0", r = parseExpr(src);
      if (r.err) throw `F${a[1]}: ${r.err}`;
      t[a] = src;
    });
  } catch (e) { if (typeof e === "string") return { err: e }; throw e; }
  return { t };
}
// The page settings a Try link asks for, as a copy (P itself changes only when the link really loads).
function tryToP(t) {
  const s = (live() ? app.S : app.sim && app.sim.state()) || {};
  const next = JSON.parse(JSON.stringify(P));
  next.preset = t.preset;
  ["k", "b", "fmax", "fx", "fy", "fz"].forEach(n => { if (t[n] !== undefined) next[n] = t[n]; });
  next.rpy = t.rpy.slice();
  let note = "", herePending = false;
  if (t.xd === "here") {
    if (s.cal && vec3(s.x)) next.xd = s.x.map(v => clamp(v, -0.3, 0.3));
    else {                                         // no position yet: the target moves to the cursor the moment
      herePending = true;                          // the device reports a calibrated position (see onState)
      note = " The device is not calibrated yet: as soon as it is, the target x_d moves to the cursor by itself.";
    }
  } else if (t.xd) next.xd = t.xd.slice();
  return { next, label: PRESETS[t.preset].label, note, herePending };
}
// "xd=here" on an uncalibrated device: put the target at the cursor at the first calibrated state.
function resolvePendingHere(s) {
  if (!app.xdHerePending || !s || !s.cal || !vec3(s.x) || !inControl()) return;
  app.xdHerePending = false;
  P.xd = s.x.map(v => clamp(v, -0.3, 0.3));
  pushParams();
  toast("The device is calibrated: the target x_d is now at the cursor.", "good");
}
// Everything the force depends on. If a Try link or the Equation lab changes any of it while forces are on,
// forces go off first: a new force law should never start under a hand that is not expecting it.
const lawKey = p => JSON.stringify([p.preset, p.k, p.b, p.xd, p.rpy, p.preset === "custom" ? [p.fx, p.fy, p.fz] : 0]);
async function loadNewLaw(next) {
  const s = (live() ? app.S : app.sim && app.sim.state()) || {};
  const changes = lawKey(next) !== lawKey(P);
  let switchedOff = false;
  if (s.on && changes) {
    clearTimeout(sendTimer);
    if (!(await send("forces 0"))) return { ok: false };
    switchedOff = true;
  }
  Object.assign(P, next);
  pushParams();
  return { ok: true, switchedOff, unchangedOn: !!s.on && !changes };
}
async function applyTry(hp) {
  history.replaceState(null, "", "#tab=play");
  showTab("play");
  const r = parseTry(hp);
  if (r.err) { toast("This Try-it link was not loaded: " + r.err + ".", "bad"); return; }
  const label = PRESETS[r.t.preset].label;
  if (!inControl()) {
    if (viewOnly()) { toast(`This is a watch-only link, so “${label}” cannot be loaded on the device.`, "bad"); return; }
    const c = (app.S && app.S.control) || {};
    if (c.holder) { toast(`${c.holder} is driving the device right now, so “${label}” was not loaded. Ask them to release control, then click the link again.`, "bad"); return; }
    app.pendingTry = { ...r.t, at: performance.now() };        // loaded when you press "Take control" (within a minute)
    renderPendingTry();
    toast(`${label} is ready. Press “Take control” (top right) within a minute and it loads on the device.`, "info", 4000);
    return;
  }
  const { next, note, herePending } = tryToP(r.t);
  const res = await loadNewLaw(next);
  if (!res.ok) { toast("Forces could not be switched off first, so the Try-it link was not loaded.", "bad"); return; }
  app.xdHerePending = herePending;
  if (P.preset === "custom") syncEqInputs();
  if (res.switchedOff) toast(`Loaded: ${label}. Forces were switched OFF because the force law changed: switch them on again when you are holding the handle.${note}`, "bad", 6000);
  else if (res.unchangedOn) toast(`${label}: these settings are already running, forces stay on.`);
  else toast(`Loaded: ${label}.${note} Switch forces on when you are holding the handle.`, note ? "bad" : "info", 4000);
}
// A waiting Try link is dropped after a minute, or as soon as someone else holds control.
function checkPendingTry() {
  const pt = app.pendingTry;
  if (!pt || inControl()) return;
  const c = (app.S && app.S.control) || {}, label = PRESETS[pt.preset].label;
  if (c.holder) { app.pendingTry = null; toast(`“${label}” was not loaded: ${c.holder} is driving the device. Ask them to release control, then click the link again.`, "bad"); }
  else if (performance.now() - pt.at > TRY_WAIT_MS) { app.pendingTry = null; toast(`“${label}” was not loaded within a minute, so it was dropped. Click the link again when you are ready.`, "bad"); }
  if (!app.pendingTry) renderPendingTry();
}
function renderPendingTry() {
  const box = $("#pending-try"), pt = app.pendingTry;
  if (!pt) { if (box._pt) { box._pt = null; box.replaceChildren(); } return; }
  if (box._pt !== pt) {                    // built once per link; only the seconds change, so the button stays clickable
    box._pt = pt;
    box.replaceChildren(status("info", `Ready to load: ${PRESETS[pt.preset].label}. `, h("span", {}, "Press “Take control” (top right) within ", h("b", { class: "secs" }), " s and it loads on the device. ",
      h("button", { class: "btn small", type: "button", onclick: () => { app.pendingTry = null; renderPendingTry(); } }, "Forget it"))));
  }
  const b = box.querySelector(".secs");
  if (b) b.textContent = String(Math.max(0, Math.ceil((TRY_WAIT_MS - (performance.now() - pt.at)) / 1000)));
}

// =========================================================================================== start tab
function renderStartSteps() {
  if (currentTab !== "start") return;
  const s = app.S || {}, c = s.control || {};
  const moved = trail.top.length > 20 && (() => { let L = 0; for (let i = 1; i < trail.top.length; i++) L += norm3(sub(trail.top[i], trail.top[i - 1])); return L > 0.03; })();
  const realDevice = live() && !s.sim;
  const steps = [
    { done: app.mode === "live" || app.mode === "sim", title: "Open the console",
      text: app.mode === "needkey" ? "This page needs the lab key: open the full link your instructor gave you (it ends with ?key=…)." :
        live() ? "You are connected to the lab Pi." : "You are in the simulator (no device). In the lab, open the link with ?key=… instead." },
    { done: !!myName(), title: "Type your name (top right)", text: "Others see it while you are in control." },
    { done: !realDevice || s.connected, title: "Find the Haply", text: realDevice ? (s.released ? "The device is released to a terminal program. Press “Give the device back” in the Terminal tab." : s.connected ? `Inverse3 #${s.dev} is connected to the Pi.` : "Not found: check the blue USB cable on the Pi, then wait a few seconds.") : "Simulator: nothing to plug in." },
    { done: !realDevice || s.cal, title: "Calibrate it", text: "Look at the LED on the front. Purple = not calibrated. Rest the cursor on the magnetic dock until the LED changes colour, then lift it off. The position numbers in Play stop being 0." },
    { done: inControl(), title: "Take control", text: viewOnly() ? "This is a watch-only link: you can watch and press Stop forces, but not drive. Open the full lab link from your instructor to drive." :
        live() ? (c.holder && !c.you ? `${c.holder} is driving now. Ask them to release, or just watch.` : "Press “Take control” at the top right. One person drives at a time; everyone can watch.") : "In the simulator you are always in control." },
    { done: moved, title: "Move the handle and watch the dot", text: realDevice ? "Open Play and move the handle slowly: the blue dot follows. The grid squares are 1 cm." : "Open Play and drag inside a view: the virtual hand pulls the dot." , action: ["Open Play", () => (location.hash = "tab=play")] },
    { done: !!(s.on && norm3(s.f || [0, 0, 0]) > 0.2), title: "Feel your first spring", text: (realDevice ? "Plug in the motor power cable (the handle may jump a little: hold it). " : "") + "Load a gentle spring at the cursor, then switch forces on and pull the handle 1–2 cm away.",
      action: ["Load a gentle spring here", () => (location.hash = "try=spring&k=150&b=2&xd=here")] },
    { done: !!(app._recordedOnce), title: "Record 10 seconds", text: "In Experiment, start a recording, push against the spring, stop, and look at the plot.", action: ["Open Experiment", () => (location.hash = "tab=experiment")] },
    { done: false, title: "Read why it works", text: "Lesson 4 explains the equation you just felt, line by line.", action: ["Open lesson 4", () => (location.hash = "lesson=04-impedance-control.md")] },
  ];
  const now = steps.findIndex(x => !x.done);
  $("#start-steps").replaceChildren(...steps.map((st, i) => h("li", { class: st.done ? "done" : i === now ? "now" : "" },
    h("div", { class: "dot", text: st.done ? "✓" : String(i + 1) }),
    h("div", {}, h("h4", { text: st.title }), h("p", { text: st.text }), st.action ? h("button", { class: "btn small" + (i === now ? " primary" : ""), type: "button", onclick: st.action[1] }, st.action[0]) : null))));
}
function renderModeBanner() {
  const b = $("#mode-banner");
  if (app.mode === "needkey") {
    const inp = h("input", { type: "text", placeholder: "lab key" });
    b.replaceChildren(status("bad", "This console needs the lab key. ", h("span", {}, "Paste it here: ", inp, " ", h("button", { class: "btn small", type: "button", onclick: () => { store.set("key", inp.value.trim()); location.reload(); } }, "Use key"))));
  } else if (!live()) {
    b.replaceChildren(status("info", "You are using the simulator. ", h("span", {}, "Everything works except the real device, the terminal and sending feedback to the instructor. Forces move a virtual hand that you drag with the mouse. In the lab, open the link with ", h("code", { text: "?key=…" }), " to drive the real Haply.")));
  } else if (viewOnly()) {
    b.replaceChildren(status("info", "This is a watch-only link. ", h("span", { text: "You see everything live, can read the code and the lessons, and can press Stop forces. Driving the device, recordings, the terminal and feedback need the full lab link from your instructor." })));
  } else b.replaceChildren();
  $("#mode-label").textContent = app.mode === "live" ? "live on " + (app.hello ? app.hello.host : "the lab Pi") : app.mode === "sim" ? "simulator" : "";
  $("#nav-foot").replaceChildren(h("a", { href: GITHUB, target: "_blank", rel: "noopener", text: "GitHub repository" }), h("br"), h("a", { href: PAGES, target: "_blank", rel: "noopener", text: "Public simulator" }));
}

// =========================================================================================== experiment
const PROTOCOLS = [
  { id: "spring", title: "Measure the spring constant", try: "try=spring&k=200&b=1&xd=here&rpy=0,0,0", label: "spring-k200",
    steps: ["Load the spring at the cursor (button) and switch forces on.", "Start recording.", "Pull the handle slowly 1 cm to the right, hold 2 s; then 2 cm; then 3 cm. Let go back to the centre each time.", "Stop recording, press Analyse, choose e1 → f1."],
    q: "Is the slope close to 200 N/m? Why would it be a bit lower (hint: the force limit, your hand, the 1 s fade-in)?" },
  { id: "damping", title: "What does damping do?", try: "try=damping&b=4", label: "damping-b4",
    steps: ["Load the damping field and switch forces on.", "Record while you move the handle slowly, then quickly, left and right.", "Analyse VX → f1."],
    q: "The points should lie on a line through zero. What is its slope, and what sign does it have? Why?" },
  { id: "wall", title: "Wall stiffness: does it buzz?", try: "try=wall&k=300&b=0&fmax=4&xd=here&rpy=0,0,0", label: "wall-k300-b0",
    steps: ["Predict first: work out kT/2 for k = 300 and k = 800 N/m with T = 0.001 s (Lesson 6, section 1).", "Load the wall just below the cursor (move the target 1 cm down after loading). The button sets the force limit to 4 N.", "Record while you touch the wall lightly 5 times, holding the handle with your fingertips. Stay in the first few mm: do not push through.", "Repeat with k = 800, b = 0, then k = 800, b = 3 (new recordings). Compare e3 and f3 over time."],
    q: "Did any setting buzz? Where is f3 flat at the force limit, and how deep (e3) were you then? Compare with fmax / k. Use kT/2 to explain what you felt (Lesson 6)." },
  { id: "line", title: "Follow a line (virtual fixture)", try: "try=line&k=300&b=2&xd=here&rpy=0,90,0", label: "line-guide-on",
    // Load the guide first, so both recordings measure e in the same frame and from the same x_d. With pitch 90°
    // the free direction (the frame's z axis) is device X, so e3 is the motion along the line and e1, e2 are sideways.
    steps: ["Load the line guide (button below; pitch 90° turns the line to point along X). Leave forces OFF and record 10 s tracing a straight line left-right.",
      "Switch forces ON and record the same movement again.",
      "Analyse both recordings: choose time t on the horizontal axis and look at e1, then e2 (the sideways error). e3 is the movement along the line, so it is large in both."],
    q: "By how much did the sideways error shrink with the guide? How would this help a surgeon trace an incision?" },
];
function buildProtocols() {
  $("#protocols").replaceChildren(...PROTOCOLS.map(p => h("div", { class: "card protocol" },
    h("h4", { text: p.title }), h("ol", {}, ...p.steps.map(s => h("li", { text: s }))), h("p", { class: "q", text: "Question: " + p.q }),
    h("div", { class: "row" }, h("button", { class: "btn small", type: "button", onclick: () => (location.hash = p.try) }, "Set it up in Play"),
      h("button", { class: "btn small", type: "button", onclick: () => { $("#rec-label").value = p.label; $("#rec-notes").value = p.title + ". " + ($("#rec-notes").value || ""); toast("Label filled in. Press Start recording when ready."); } }, "Use this label")))));
}
$("#btn-rec").addEventListener("click", async () => {
  const s = app.S || {};
  if (!inControl()) { toast("Take control first.", "bad"); return; }
  if (s.rec) { await send("rec stop"); app._recordedOnce = true; app._waitFile = s.last_file || ""; setTimeout(refreshRecordings, 800); setTimeout(refreshRecordings, 2500); }
  else { const label = ($("#rec-label").value || "experiment").replace(/[^\w -]/g, "").slice(0, 60); await send("rec start " + label); }
});
function renderRecStatus(s) {
  $("#btn-rec").textContent = s.rec ? `■ Stop recording (${fmt(s.rec_s, 1)} s)` : "● Start recording";
  $("#btn-rec").className = "btn " + (s.rec ? "danger" : "primary");
  $("#rec-status").textContent = s.rec ? `Recording “${s.rec_label}” at ${Math.round(s.hz || 1000)} samples per second…` : s.last_file ? "Last saved: " + s.last_file : "";
  if (app._waitFile !== undefined && s.last_file && s.last_file !== app._waitFile) { app._waitFile = undefined; refreshRecordings(); saveNotesFor(s.last_file); }
}
async function saveNotesFor(name) {
  const notes = $("#rec-notes").value.trim();
  if (!notes) return;
  if (live()) await api(`recordings/${encodeURIComponent(name)}/notes`, { notes }).catch(() => {});
  else { const r = app.sim.recs.find(x => x.name === name); if (r) r.notes = notes; }
}
async function refreshRecordings() {
  let list = [];
  if (live()) { try { list = await api("recordings"); } catch { return; } }
  else list = app.sim ? app.sim.recs : [];
  const box = $("#rec-list");
  if (!list.length) { box.replaceChildren(h("p", { class: "note", text: "No recordings yet." })); return; }
  box.replaceChildren(h("table", { class: "data" }, h("thead", {}, h("tr", {}, h("th", { text: "Recording" }), h("th", { text: "Scenario" }), h("th"))),
    h("tbody", {}, ...list.slice(0, 40).map(r => h("tr", {},
      h("td", {}, h("div", { class: "mono small", text: r.name }), r.notes ? h("div", { class: "small muted", text: r.notes.slice(0, 120) }) : null),
      h("td", { class: "small", text: (r.scenario || "").replace(/xd=\S+ /, "").slice(0, 70) }),
      h("td", {}, h("button", { class: "btn small primary", type: "button", onclick: () => analyse(r) }, "Analyse"), " ",
        h("button", { class: "btn small", type: "button", onclick: () => downloadRec(r) }, "CSV")))))));
}
async function recText(r) {
  if (!live()) return r.csv;
  if (viewOnly()) throw new Error("a watch-only link can list the recordings but not open them");
  const res = await fetch(`api/recordings/${encodeURIComponent(r.name)}?key=${encodeURIComponent(KEY())}`);
  if (!res.ok) throw new Error(res.status === 403 ? "this needs the lab key" : "the server answered " + res.status);
  return res.text();
}
async function downloadRec(r) {
  if (viewOnly()) { toast("A watch-only link can list the recordings but not download them.", "bad"); return; }
  if (live()) { const a = h("a", { href: `api/recordings/${encodeURIComponent(r.name)}?key=${encodeURIComponent(KEY())}`, download: r.name }); document.body.append(a); a.click(); a.remove(); return; }
  const a = h("a", { href: URL.createObjectURL(new Blob([r.csv], { type: "text/csv" })), download: r.name }); document.body.append(a); a.click(); a.remove();
}
function parseLog(text) {
  const lines = text.split(/\r?\n/);
  const hdr = lines.findIndex(l => l.startsWith("Time(ms)"));
  if (hdr < 0) throw new Error("not a myHAPLY log");
  const cols = lines[hdr].split(",");
  const meta = lines.slice(0, hdr).filter(l => l.startsWith("#")).map(l => l.slice(1).trim());
  const data = {}; cols.forEach(c => (data[c] = []));
  for (let i = hdr + 1; i < lines.length; i++) { if (!lines[i]) continue; const p = lines[i].split(","); cols.forEach((c, j) => data[c].push(+p[j])); }
  return { cols, data, meta, n: data["Time(s)"].length };
}
let AN = null;
async function analyse(r) {
  let L;
  try { L = parseLog(await recText(r)); } catch (e) { toast("Cannot read: " + e.message, "bad"); return; }
  AN = { r, L };
  $("#analysis").classList.remove("hidden");
  $("#an-title").textContent = "Analysis: " + r.name;
  const D = L.data, t = D["Time(s)"], n = L.n;
  const valid = D.VX.map((v, i) => !(v >= 65000 && D.VY[i] >= 65000));
  const fon = D.ramp ? D.ramp.filter(v => v >= 0.999).length / n : 0;
  const Fm = D.f1 ? Math.max(...D.f1.map((f, i) => Math.hypot(f, D.f2[i], D.f3[i]))) : 0;
  $("#an-tiles").replaceChildren(...[["Samples", n.toLocaleString(), fmt(t[n - 1] - t[0], 2) + " s"], ["Rate", Math.round((n - 1) / (t[n - 1] - t[0] || 1)) + " Hz", "samples per second"],
    ["Forces fully on", Math.round(fon * 100) + " %", "of the samples"], ["Largest force", fmt(Fm, 2) + " N", "|F|"], ["Calibrated", Math.round(100 * valid.filter(Boolean).length / n) + " %", "of the samples"]]
    .map(([k, v, s]) => h("div", { class: "tile" }, h("div", { class: "k", text: k }), h("div", { class: "v", text: v }), h("div", { class: "s", text: s }))));
  const rows = downsample(t.map((tt, i) => ({ t: tt, x: valid[i] ? D.X[i] : NaN, y: valid[i] ? D.Y[i] : NaN, z: valid[i] ? D.Z[i] : NaN,
    f1: D.f1 ? D.f1[i] : 0, f2: D.f2 ? D.f2[i] : 0, f3: D.f3 ? D.f3[i] : 0 })), 1200);
  lineChart($("#an-pos"), "Position", "metres", rows, [{ k: "x", n: "X", c: "--series-1" }, { k: "y", n: "Y", c: "--series-2" }, { k: "z", n: "Z", c: "--series-3" }], v => fmt(v, 4) + " m");
  lineChart($("#an-force"), "Force sent to the device", "newtons", rows, [{ k: "f1", n: "F1", c: "--series-1" }, { k: "f2", n: "F2", c: "--series-2" }, { k: "f3", n: "F3", c: "--series-3" }], v => fmt(v, 2) + " N");
  const choices = L.cols.filter(c => !["Time(ms)", "Unix_epoch(ns)", "Index", "loop_us"].includes(c));
  const fx = $("#fit-x"), fy = $("#fit-y");
  const guess = (r.scenario || "").includes("kind=wall") ? ["e3", "f3"] : (r.scenario || "").includes("k=[0.0,0.0,0.0]") ? ["VX", "f1"] : ["e1", "f1"];
  fx.replaceChildren(...choices.map(c => h("option", { value: c, text: COLNAME[c] || c })));
  fy.replaceChildren(...choices.map(c => h("option", { value: c, text: COLNAME[c] || c })));
  fx.value = choices.includes(guess[0]) ? guess[0] : choices[0]; fy.value = choices.includes(guess[1]) ? guess[1] : choices[1];
  fitPlot();
  $("#analysis").scrollIntoView({ behavior: "smooth" });
}
const COLNAME = { "Time(s)": "time t (s)", X: "X position (m)", Y: "Y position (m)", Z: "Z position (m)", VX: "VX (m/s)", VY: "VY (m/s)", VZ: "VZ (m/s)",
  f1: "F1 force (N)", f2: "F2 force (N)", f3: "F3 force (N)", e1: "e1 error, target frame (m)", e2: "e2 error (m)", e3: "e3 error / wall depth (m)", ramp: "force ramp (0..1)" };
["#fit-x", "#fit-y", "#fit-on"].forEach(s => $(s).addEventListener("change", fitPlot));
function fitPlot() {
  if (!AN) return;
  const D = AN.L.data, xk = $("#fit-x").value, yk = $("#fit-y").value, onlyOn = $("#fit-on").checked;
  const pts = [];
  for (let i = 0; i < AN.L.n; i++) { if (onlyOn && D.ramp && D.ramp[i] < 0.999) continue; const x = D[xk][i], y = D[yk][i];
    if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e4 && Math.abs(y) < 1e4) pts.push([x, y]); }
  const fit = linfit(pts);
  scatterChart($("#an-fit"), pts, fit, COLNAME[xk] || xk, COLNAME[yk] || yk);
  const unit = (COLNAME[yk] || "").match(/\((.*)\)/), unitx = (COLNAME[xk] || "").match(/\((.*)\)/);
  $("#fit-text").textContent = fit ? `Best straight line: ${COLNAME[yk] || yk} = ${fmt(fit.a, 4)} × ${COLNAME[xk] || xk} ${fit.b >= 0 ? "+" : "−"} ${fmt(Math.abs(fit.b), 4)}.  Slope = ${fmt(fit.a, 2)} ${unit && unitx ? unit[1] + "/" + unitx[1] : ""}, R² = ${fmt(fit.r2, 3)}, ${pts.length.toLocaleString()} samples.` + (xk.startsWith("e") && yk.startsWith("f") ? "  For a spring, this slope is your measured stiffness k." : "") : "Not enough samples (switch forces on, or untick the box).";
  AN.fit = fit; AN.xk = xk; AN.yk = yk;
}
function linfit(p) {
  const n = p.length; if (n < 5) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0; p.forEach(([x, y]) => { sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; });
  const d = n * sxx - sx * sx; if (Math.abs(d) < 1e-18) return null;
  const a = (n * sxy - sx * sy) / d, b = (sy - a * sx) / n;
  const r = (n * sxy - sx * sy) / Math.sqrt(d * (n * syy - sy * sy) || 1);
  return { a, b, r2: r * r, n };
}
$("#btn-add-fig").addEventListener("click", () => {
  if (!AN) return;
  addReportItem({ type: "figure", title: `${COLNAME[AN.yk] || AN.yk} against ${COLNAME[AN.xk] || AN.xk}`, svg: $("#an-fit svg") ? $("#an-fit svg").outerHTML : "",
    text: $("#fit-text").textContent, source: AN.r.name, scenario: AN.r.scenario || "" });
  toast("Added to your report (Report tab).", "good");
});

// ---- charts (SVG, with a crosshair tooltip)
function downsample(R, n) { if (R.length <= n) return R; const out = [], st = R.length / n; for (let i = 0; i < n; i++) out.push(R[Math.floor(i * st)]); return out; }
function niceTicks(lo, hi, n = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]; if (lo === hi) { lo -= 1e-3; hi += 1e-3; }
  const span = hi - lo, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const st = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => span / s <= n) || 10 * mag;
  const a = Math.floor(lo / st + 1e-9), b = Math.ceil(hi / st - 1e-9); const t = []; for (let i = a; i <= b; i++) t.push(+(i * st).toFixed(12)); return t;
}
const NS = "http://www.w3.org/2000/svg";
const sv = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.append(e); return e; };
function chartShell(box, title, cap, series) {
  box.replaceChildren(h("h4", { text: title }), h("p", { class: "cap", text: cap }));
  if (series && series.length > 1) box.append(h("div", { class: "legend" }, ...series.map(s => h("span", {}, h("i", { style: `background:${css(s.c)}` }), s.n))));
  const tip = h("div", { class: "tip" }); box.append(tip); return tip;
}
function lineChart(box, title, cap, rows, series, fmtV, xu = " s") {
  const tip = chartShell(box, title, cap, series);
  const W = Math.max(320, box.clientWidth - 28), H = 200, m = { l: 58, r: 30, t: 8, b: 24 };
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": title }, box);
  const xs = rows.map(r => r.t); let lo = Infinity, hi = -Infinity;
  rows.forEach(r => series.forEach(s => { const v = r[s.k]; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const yt = niceTicks(lo, hi), y0 = yt[0], y1 = yt[yt.length - 1], xt = niceTicks(xs[0], xs[xs.length - 1], 6);
  const X = t => m.l + (t - xs[0]) / ((xs[xs.length - 1] - xs[0]) || 1) * (W - m.l - m.r), Y = v => H - m.b - (v - y0) / ((y1 - y0) || 1) * (H - m.t - m.b);
  yt.forEach(v => { sv("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: css("--grid") }, svg); sv("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end" }, svg).textContent = +v.toPrecision(4); });
  xt.filter(v => v >= xs[0] && v <= xs[xs.length - 1]).forEach(v => (sv("text", { x: X(v), y: H - 6, "text-anchor": "middle" }, svg).textContent = v + xu));
  series.forEach(s => { let d = "", pen = false, last = null;
    rows.forEach(r => { const v = r[s.k]; if (!Number.isFinite(v)) { pen = false; return; } d += (pen ? "L" : "M") + X(r.t).toFixed(1) + "," + Y(v).toFixed(1); pen = true; last = r; });
    sv("path", { d, fill: "none", stroke: css(s.c), "stroke-width": 2, "stroke-linejoin": "round" }, svg);
    if (series.length > 1 && last) sv("text", { x: X(last.t) + 5, y: Y(last[s.k]) + 4, class: "dl" }, svg).textContent = s.n; });
  const cross = sv("line", { y1: m.t, y2: H - m.b, stroke: css("--axis"), visibility: "hidden" }, svg);
  const hit = sv("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" }, svg);
  hit.addEventListener("pointermove", ev => {
    const pt = svg.getBoundingClientRect(), sx = (ev.clientX - pt.left) * (W / pt.width);
    let best = 0, bd = Infinity; rows.forEach((r, i) => { const dd = Math.abs(X(r.t) - sx); if (dd < bd) { bd = dd; best = i; } });
    const r = rows[best]; cross.setAttribute("x1", X(r.t)); cross.setAttribute("x2", X(r.t)); cross.setAttribute("visibility", "visible");
    tip.replaceChildren(h("div", { class: "t", text: xu === " s" ? `t = ${fmt(r.t, 3)} s` : `${r.t}${xu}` }), ...series.map(s => h("div", { class: "r" }, h("i", { style: `background:${css(s.c)}` }), h("b", { text: Number.isFinite(r[s.k]) ? fmtV(r[s.k]) : "–" }), h("span", { text: s.n }))));
    tip.style.display = "block"; const bx = box.getBoundingClientRect(); let left = ev.clientX - bx.left + 14; if (left + 170 > bx.width) left -= 190;
    tip.style.left = left + "px"; tip.style.top = (ev.clientY - bx.top + 10) + "px";
  });
  hit.addEventListener("pointerleave", () => { tip.style.display = "none"; cross.setAttribute("visibility", "hidden"); });
}
function scatterChart(box, pts, fit, xl, yl) {
  box.replaceChildren();
  if (!pts.length) return;
  const W = Math.max(320, box.clientWidth - 4), H = 280, m = { l: 60, r: 14, t: 10, b: 40 };
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": yl + " against " + xl, xmlns: NS }, box);
  const sample = pts.length > 2500 ? pts.filter((_, i) => i % Math.ceil(pts.length / 2500) === 0) : pts;
  const xs = sample.map(p => p[0]), ys = sample.map(p => p[1]);
  const xt = niceTicks(Math.min(...xs), Math.max(...xs)), yt = niceTicks(Math.min(...ys), Math.max(...ys));
  const X = v => m.l + (v - xt[0]) / ((xt[xt.length - 1] - xt[0]) || 1) * (W - m.l - m.r), Y = v => H - m.b - (v - yt[0]) / ((yt[yt.length - 1] - yt[0]) || 1) * (H - m.t - m.b);
  const grid = css("--grid"), muted = css("--text-muted");
  yt.forEach(v => { sv("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: grid }, svg); const t = sv("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", fill: muted, "font-size": 11 }, svg); t.textContent = +v.toPrecision(3); });
  xt.forEach(v => { const t = sv("text", { x: X(v), y: H - 24, "text-anchor": "middle", fill: muted, "font-size": 11 }, svg); t.textContent = +v.toPrecision(3); });
  sv("text", { x: (W + m.l) / 2, y: H - 6, "text-anchor": "middle", fill: muted, "font-size": 12 }, svg).textContent = xl;
  const yl_ = sv("text", { x: 12, y: H / 2, "text-anchor": "middle", fill: muted, "font-size": 12, transform: `rotate(-90 12 ${H / 2})` }, svg); yl_.textContent = yl;
  const c1 = css("--series-1");
  sample.forEach(p => sv("circle", { cx: X(p[0]).toFixed(1), cy: Y(p[1]).toFixed(1), r: 1.8, fill: c1, "fill-opacity": 0.35 }, svg));
  if (fit) { const a = xt[0], b = xt[xt.length - 1]; sv("line", { x1: X(a), y1: Y(fit.a * a + fit.b), x2: X(b), y2: Y(fit.a * b + fit.b), stroke: css("--series-2"), "stroke-width": 2.5 }, svg); }
}

// =========================================================================================== learn
let lessons = null, lessonsLoading = null, currentLesson = null;
function loadLessonList() {
  if (!lessonsLoading) lessonsLoading = (async () => {
    try { lessons = await (await fetch("learn/index_v2.json")).json(); } catch { lessons = []; }
    $("#lesson-list").replaceChildren(...lessons.map(l => h("button", { type: "button", "data-file": l.file, onclick: () => (location.hash = "lesson=" + l.file) },
      h("b", { text: l.title }), h("span", { text: `${l.minutes || "?"} min · ${l.summary || ""}` }))));
  })();
  return lessonsLoading;
}
async function initLearn() {
  await loadLessonList();
  // open the first lesson only if nothing was asked for (a #lesson= link sets currentLesson first)
  setTimeout(() => { if (!currentLesson && lessons.length) openLesson(lessons[0].file); }, 0);
}
async function openLesson(file) {
  if (!/^[\w.-]+\.md$/.test(file)) return;
  currentLesson = file;
  await loadLessonList();
  $$("#lesson-list button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.file === file)));
  let md = "";
  try { const r = await fetch("learn/" + file); if (!r.ok) throw 0; md = await r.text(); } catch { $("#lesson").replaceChildren(h("p", { class: "note", text: "Could not load this lesson." })); return; }
  if (currentLesson !== file) return;          // a newer request won
  $("#lesson").innerHTML = renderMarkdown(md);
  $$("#lesson a").forEach(a => { const href = a.getAttribute("href") || ""; if (!href.startsWith("#")) { a.target = "_blank"; a.rel = "noopener"; } });
  $("#lesson-edit").href = `${GITHUB}/edit/main/docs/learn/${file}`;
  $("#lesson-q").value = "";
  window.scrollTo(0, 0);
}
function renderMarkdown(md) {
  // protect code, pull out the maths, let marked do the rest, put the maths back as MathML (Temml)
  const code = [], math = [];
  md = md.replace(/```[\s\S]*?```|`[^`\n]+`/g, m => `\u0000C${code.push(m) - 1}\u0000`);
  md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => `\u0000M${math.push({ t, d: true }) - 1}\u0000`);
  md = md.replace(/\$([^$\n]+?)\$/g, (_, t) => `\u0000M${math.push({ t, d: false }) - 1}\u0000`);
  md = md.replace(/\u0000C(\d+)\u0000/g, (_, i) => code[i]);
  let html = window.marked ? marked.parse(md) : "<pre>" + esc(md) + "</pre>";
  html = html.replace(/\u0000M(\d+)\u0000/g, (_, i) => { const m = math[i]; return m.d ? `<div class="math-display">${texString(m.t, true)}</div>` : texString(m.t, false); });
  return html;
}
$$("[data-vote]").forEach(b => b.addEventListener("click", () => {
  sendFeedback({ kind: b.dataset.vote === "clear" ? "lesson-clear" : "unclear", where: "lesson " + currentLesson, text: b.dataset.vote === "clear" ? "This lesson was clear." : "Parts of this lesson were unclear." });
  if (b.dataset.vote === "unclear") $("#lesson-q").focus();
}));
$("#lesson-send").addEventListener("click", () => {
  const t = $("#lesson-q").value.trim(); if (!t) { toast("Write what was confusing first.", "bad"); return; }
  sendFeedback({ kind: "unclear", where: "lesson " + currentLesson, text: t }); $("#lesson-q").value = "";
});

// =========================================================================================== code
const OFFLINE_FILES = ["libs/myHAPLY_SCENARIOS.h", "libs/myEXPR.h", "libs/myHAPLY_v1.h", "libs/mySERIAL.h", "libs/myINCLUDES.h", "libs/myHAPLY_LOGGING.h",
  "libs/myUDP.h", "lab/engine/haply_lab_engine.cpp", "lab/haply_lab.py", "lab/haply_term.py", "100-Haply-basics/01_read_fbk.cpp", "libs/myGEOMETRY/myROT.h", "libs/myGEOMETRY/mySE3.h", "CMakeLists.txt"];
const srcCache = {};
async function loadSource(path) {
  if (srcCache[path]) return srcCache[path];
  try {
    if (live()) { const j = await api("source?path=" + encodeURIComponent(path)); return (srcCache[path] = j.text); }
    const r = await fetch(RAW + path); if (!r.ok) return null; return (srcCache[path] = await r.text());
  } catch { return null; }
}
let annotations = null, currentFile = null;
async function initCode() {
  if (!app.files) {
    app.files = OFFLINE_FILES;
    if (live()) { try { const f = await api("files"); const pri = OFFLINE_FILES.filter(x => f.includes(x)); app.files = pri.concat(f.filter(x => !pri.includes(x))); } catch {} }
    $("#file-list").replaceChildren(...app.files.map(f => h("button", { type: "button", "data-f": f, title: f, onclick: () => openFile(f) }, f)));
  }
  if (!annotations) { try { annotations = await (await fetch("learn/annotations_v2.json")).json(); } catch { annotations = {}; } }
  if (!currentFile) openFile("libs/myHAPLY_SCENARIOS.h");
}
const KW = /\b(class|struct|enum|namespace|return|if|else|for|while|switch|case|break|continue|const|constexpr|inline|static|bool|int|double|float|void|auto|using|public|private|template|typename|def|import|from|True|False|None|with|try|except|finally|lambda|self|nullptr|true|false|std|Eigen)\b/g;
function highlight(line, lang, state) {
  let out = "", i = 0;
  const L = line;
  if (state.inBlock) { const e = L.indexOf("*/"); if (e < 0) return `<span class="c">${esc(L)}</span>`; out += `<span class="c">${esc(L.slice(0, e + 2))}</span>`; i = e + 2; state.inBlock = false; }
  let buf = "";
  const flush = () => { out += esc(buf).replace(KW, '<span class="k">$1</span>').replace(/\b(\d+\.?\d*(?:e-?\d+)?)\b/g, '<span class="nm">$1</span>'); buf = ""; };
  while (i < L.length) {
    const two = L.slice(i, i + 2);
    if ((lang === "c" && two === "//") || (lang === "py" && L[i] === "#") || (lang === "c" && L[i] === "#" && L.slice(0, i).trim() === "")) {
      if (lang === "c" && L[i] === "#") { flush(); out += `<span class="k">${esc(L.slice(i))}</span>`; return out; }
      flush(); out += `<span class="c">${esc(L.slice(i))}</span>`; return out;
    }
    if (lang === "c" && two === "/*") { const e = L.indexOf("*/", i + 2); flush(); if (e < 0) { out += `<span class="c">${esc(L.slice(i))}</span>`; state.inBlock = true; return out; } out += `<span class="c">${esc(L.slice(i, e + 2))}</span>`; i = e + 2; continue; }
    if (L[i] === '"' || L[i] === "'") { const q = L[i]; let j = i + 1; while (j < L.length && L[j] !== q) { if (L[j] === "\\") j++; j++; } flush(); out += `<span class="s">${esc(L.slice(i, j + 1))}</span>`; i = j + 1; continue; }
    buf += L[i++];
  }
  flush(); return out;
}
async function openFile(path) {
  await initCode();
  currentFile = path;
  $$("#file-list button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.f === path)));
  $("#file-name").textContent = path; $("#file-gh").href = `${GITHUB}/blob/main/${path}`;
  const text = await loadSource(path);
  if (text === null) { $("#src").replaceChildren(h("p", { class: "note", style: "padding:10px", text: "Could not load this file." })); return; }
  const lines = text.split("\n"), lang = /\.(py|cmake)$|CMakeLists/.test(path) ? "py" : /\.md$/.test(path) ? "md" : "c";
  const annos = ((annotations || {})[path] || []).map(a => { const i = lines.findIndex(l => l.includes(a.match)); return i < 0 ? null : { ...a, from: i, to: i + (a.span || 1) - 1 }; }).filter(Boolean);
  const hl = new Set(); annos.forEach(a => { for (let i = a.from; i <= a.to; i++) hl.add(i); });
  const st = { inBlock: false };
  const rows = lines.map((l, i) => `<tr data-l="${i + 1}"${hl.has(i) ? ' class="hl"' : ""}><td class="ln">${i + 1}</td><td>${lang === "md" ? esc(l) : highlight(l, lang, st)}</td></tr>`);
  $("#src").innerHTML = `<table>${rows.join("")}</table>`;
  $$("#src td.ln").forEach(td => td.addEventListener("click", () => askAboutLine(path, +td.parentElement.dataset.l, lines)));
  $("#annos").replaceChildren(...(annos.length ? [h("div", { class: "small muted", style: "margin-bottom:6px", text: "Explanations (click to jump):" })] : [h("p", { class: "note", text: "No explanations for this file yet. Click a line number to ask about it — your question helps us write them." })]),
    ...annos.map(a => { const box = h("div", { class: "anno", onclick: () => jumpTo(a.from + 1) }, h("h4", { text: `L${a.from + 1} · ${a.title}` }));
      const p = h("p"); p.innerHTML = renderMarkdown(a.text).replace(/^<p>|<\/p>\s*$/g, ""); box.append(p);
      if (a.lesson) box.append(h("a", { href: "#lesson=" + a.lesson, class: "small", text: "→ lesson", onclick: e => e.stopPropagation() }));
      return box; }));
}
function jumpTo(n) { const tr = $(`#src tr[data-l="${n}"]`); if (!tr) return; $$("#src tr.focus").forEach(t => t.classList.remove("focus")); tr.classList.add("focus"); tr.scrollIntoView({ block: "center", behavior: "smooth" }); }
async function askAboutLine(path, n, lines) {
  const ta = h("textarea", { placeholder: "What is unclear about this line? What did you expect it to do?" });
  const snippet = lines.slice(Math.max(0, n - 3), n + 2).join("\n");
  const body = h("div", {}, codeBlock(snippet), ta);
  const v = await modal(`${path}, line ${n}`, body, [{ label: "Cancel", value: 0 }, { label: "Add these lines to my report", value: 2 }, { label: "Send my question", cls: "primary", value: 1 }]);
  if (v === 1 && ta.value.trim()) sendFeedback({ kind: "code-question", where: `${path}:${n}`, text: ta.value.trim(), line: lines[n - 1] });
  if (v === 2) { addReportItem({ type: "code", title: `${path}, lines ${Math.max(1, n - 2)}–${n + 2}`, text: snippet, link: `${GITHUB}/blob/main/${path}#L${Math.max(1, n - 2)}-L${n + 2}` }); toast("Added to your report.", "good"); }
}

// =========================================================================================== equation lab
const EXAMPLES = [
  { n: "Spring to the target (same as the Spring preset)", fx: "-kx*(x - xd) - bx*vx", fy: "-ky*(y - yd) - by*vy", fz: "-kz*(z - zd) - bz*vz" },
  { n: "Spring on X only (a rail along Y and Z)", fx: "-kx*(x - xd) - bx*vx", fy: "0", fz: "0" },
  { n: "Soft in X, stiff in Z (anisotropic)", fx: "-0.25*kx*(x - xd)", fy: "-0.25*ky*(y - yd)", fz: "-kz*(z - zd) - bz*vz" },
  // max(0, ...) as in the Wall scenario: the damping term must never pull the hand back into the floor
  { n: "Floor at the target height (wall with step)", fx: "0", fy: "0", fz: "max(0, kz*(zd - z) - bz*vz)*step(zd - z)" },
  { n: "Viscous field (honey)", fx: "-bx*vx", fy: "-by*vy", fz: "-bz*vz" },
  { n: "Magnet: pull grows near the target, capped at 1.5 N", fx: "clamp(-0.02*(x - xd)/((x-xd)^2 + (y-yd)^2 + 0.0004), -1.5, 1.5)", fy: "clamp(-0.02*(y - yd)/((x-xd)^2 + (y-yd)^2 + 0.0004), -1.5, 1.5)", fz: "-kz*(z - zd) - bz*vz" },
  { n: "Gentle 5 Hz vibration along Z (0.3 N)", fx: "0", fy: "0", fz: "0.3*sin(2*pi*5*t)" },
];
function initEqLab() {
  const sel = $("#eq-examples");
  sel.replaceChildren(h("option", { value: "", text: "— choose an example —" }), ...EXAMPLES.map((e, i) => h("option", { value: i, text: e.n })));
  sel.addEventListener("change", () => { const e = EXAMPLES[+sel.value]; if (!e) return; $("#eq-fx").value = e.fx; $("#eq-fy").value = e.fy; $("#eq-fz").value = e.fz; eqUpdate(); });
  ["fx", "fy", "fz"].forEach(a => { $("#eq-" + a).value = P[a]; $("#eq-" + a).addEventListener("input", eqUpdate); });
  $("#btn-eq-feel").addEventListener("click", async () => {
    const r = eqParse(); if (!r.ok) { toast("Fix the equation errors first.", "bad"); return; }
    if (!inControl()) { toast("Take control first (top right).", "bad"); return; }
    const next = JSON.parse(JSON.stringify(P));
    ["fx", "fy", "fz"].forEach(a => (next[a] = exprText($("#eq-" + a).value)));
    next.preset = "custom"; if (!next.k) next.k = 200;
    const res = await loadNewLaw(next);                    // forces go off first if they are on and the law changes
    if (!res.ok) { toast("Forces could not be switched off first, so the equations were not loaded.", "bad"); return; }
    location.hash = "tab=play";
    if (res.switchedOff) toast("Loaded as “My equation”. Forces were switched OFF because the force law changed: switch them on again in Play when you are holding the handle.", "bad", 6000);
    else if (res.unchangedOn) toast("These equations are already running on the device.");
    else toast("Loaded as “My equation”. Switch forces on in Play when you are holding the handle.", "info", 4000);
  });
  $("#btn-eq-propose").addEventListener("click", proposeEquation);
}
// After a Try link loads equations, the Equation lab shows them too (so "Load it on the device" starts from them).
function syncEqInputs() { ["fx", "fy", "fz"].forEach(a => { const e = $("#eq-" + a); if (e) e.value = P[a]; }); eqUpdate(); }
function eqParse() {
  const out = { ok: true, ast: {}, err: {} };
  ["fx", "fy", "fz"].forEach(a => { const src = $("#eq-" + a).value.trim() || "0"; const r = parseExpr(src); if (r.err) { out.ok = false; out.err[a] = r.err; } else out.ast[a] = r.ast; });
  return out;
}
function eqUpdate() {
  if (!$("#eq-fx")) return;
  const r = eqParse();
  $("#eq-errors").replaceChildren(...Object.entries(r.err).map(([a, e]) => status("bad", `F${a[1]}: ${e}`)));
  $("#btn-eq-feel").disabled = !r.ok;              // only equations the device will accept can be loaded
  renderActiveExpr();
  if (!r.ok) return;
  $("#eq-latex").replaceChildren(tex(String.raw`\begin{aligned} F_x &= ${toTex(r.ast.fx)} \\ F_y &= ${toTex(r.ast.fy)} \\ F_z &= ${toTex(r.ast.fz)} \end{aligned}`));
  $("#eq-cpp").replaceChildren(codeBlock(
`// A new behaviour in libs/myHAPLY_SCENARIOS.h, inside haptics::force(...):
// x = position, v = velocity, s.x_d / s.k / s.b = target and slider values, t = time
case Kind::MyBehaviour: {
    return Vec3(${toCpp(r.ast.fx)},
                ${toCpp(r.ast.fy)},
                ${toCpp(r.ast.fz)});
}`));
  drawForceMap(r.ast); drawSweep(r.ast);
}
// The equations the engine reports as compiled and running (they can differ from this page's: an equation it
// refused, or one still on its way), shown under the Play equation and in the Equation lab.
let lastActiveKey = "";
function renderActiveExpr() {
  const s = app.S || {}, par = s.par || {};
  const has = ["fx", "fy", "fz"].every(a => typeof par[a] === "string");
  const mine = P.preset === "custom";
  const same = a => exprNorm(par[a]) === exprNorm(exprText(P[a]));
  // an error no longer matters once the engine runs what the page asks for
  ["fx", "fy", "fz"].forEach(a => { if (has && mine && same(a)) delete app.exprError[a]; });
  // The engine reports only its latest message, so "fx: ..." can be hidden by a "fy = ..." right after it. An equation
  // this page sent more than 1.5 s ago that the engine still does not run was refused, message or not.
  const late = has && mine && inControl() ? ["fx", "fy", "fz"].filter(a => !same(a) && !app.exprError[a] &&
    app.exprSent[a] === exprText(P[a]) && performance.now() - (app.exprSentAt[a] || 0) > 1500) : [];
  const errs = Object.values(app.exprError).concat(late.map(a => `F${a[1]} = ${exprText(P[a])} was not taken`));
  const key = JSON.stringify([has, par.kind, par.fx, par.fy, par.fz, errs, mine, P.fx, P.fy, P.fz]);
  if (key === lastActiveKey) return;
  lastActiveKey = key;
  const make = () => {
    if (!has || (par.kind !== "custom" && !mine)) return [];
    const rows = ["fx", "fy", "fz"].map(a => `F${a[1]} = ${par[a] || "0"}`).join(";   ");
    const differs = mine && ["fx", "fy", "fz"].some(a => !same(a));
    return [errs.length ? status("bad", `The device refused an equation (${errs.join("; ")}). It keeps running the ones below.`) : null,
      h("p", { class: "note active-eq" + (differs ? " differs" : ""), text: (par.kind === "custom" ? "Running on the device now: " : "Stored on the device for “My equation”: ") + rows +
        (differs && !errs.length ? "   (not yet the same as this page)" : "") })].filter(Boolean);
  };
  ["#eq-active-play", "#eq-active-lab"].forEach(sel => { const el = $(sel); if (el) el.replaceChildren(...make()); });
}
function eqScenario(ast) { return { kind: "custom", xd: P.xd, rpy: [0, 0, 0], k: [P.k, P.k, P.k], b: [P.b, P.b, P.b], ast }; }
function drawForceMap(ast) {
  const cv = $("#cv-map"), g = cv.getContext("2d"), W = cv.width, H = cv.height, half = 0.06, s = eqScenario(ast);
  g.fillStyle = css("--surface-1"); g.fillRect(0, 0, W, H);
  const X = v => W / 2 + (v - P.xd[0]) / half * W / 2, Y = v => H / 2 - (v - P.xd[1]) / half * H / 2;
  g.strokeStyle = css("--grid"); g.beginPath(); for (let i = -6; i <= 6; i++) { g.moveTo(X(P.xd[0] + i * 0.01), 0); g.lineTo(X(P.xd[0] + i * 0.01), H); g.moveTo(0, Y(P.xd[1] + i * 0.01)); g.lineTo(W, Y(P.xd[1] + i * 0.01)); } g.stroke();
  const N = 15, pts = []; let fmaxv = 1e-9;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = [P.xd[0] - half + (i + 0.5) * 2 * half / N, P.xd[1] - half + (j + 0.5) * 2 * half / N, P.xd[2]];
    const F = forceOf(s, x, [0, 0, 0], 0).F; const m = Math.hypot(F[0], F[1]); if (Number.isFinite(m)) fmaxv = Math.max(fmaxv, m); pts.push([x, F, m]);
  }
  const col = css("--series-1"), cell = W / N;
  pts.forEach(([x, F, m]) => { if (!Number.isFinite(m) || m < 1e-6) return; const L = 0.45 * cell * Math.sqrt(m / fmaxv), ux = F[0] / m, uy = F[1] / m;
    const x0 = X(x[0]), y0 = Y(x[1]), x1 = x0 + ux * L, y1 = y0 - uy * L;
    g.globalAlpha = 0.35 + 0.65 * m / fmaxv; g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    const a = Math.atan2(y1 - y0, x1 - x0); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - 6 * Math.cos(a - 0.5), y1 - 6 * Math.sin(a - 0.5)); g.lineTo(x1 - 6 * Math.cos(a + 0.5), y1 - 6 * Math.sin(a + 0.5)); g.fill(); });
  g.globalAlpha = 1; g.strokeStyle = css("--text-muted"); g.lineWidth = 2; g.beginPath(); g.arc(W / 2, H / 2, 8, 0, 7); g.stroke();
  g.fillStyle = css("--text-muted"); g.font = "13px system-ui"; g.fillText(`±6 cm around x_d · strongest arrow ${fmt(fmaxv, 2)} N (in X–Y)`, 8, H - 8);
}
function drawSweep(ast) {
  const s = eqScenario(ast), rows = [];
  for (let i = 0; i <= 120; i++) { const dx = -0.06 + i * 0.001; const F = forceOf(s, [P.xd[0] + dx, P.xd[1], P.xd[2]], [0, 0, 0], 0).F; rows.push({ t: +(dx * 1000).toFixed(1), fx: F[0], fy: F[1], fz: F[2] }); }
  lineChart($("#eq-sweep"), "Force along a line through x_d (cursor at rest, moved along X)", "horizontal: x − x_d (mm) · vertical: force (N)", rows,
    [{ k: "fx", n: "Fx", c: "--series-1" }, { k: "fy", n: "Fy", c: "--series-2" }, { k: "fz", n: "Fz", c: "--series-3" }], v => fmt(v, 2) + " N", " mm");
}
function proposeEquation() {
  const r = eqParse(); if (!r.ok) { toast("Fix the equation errors first.", "bad"); return; }
  const src = ["fx", "fy", "fz"].map(a => $("#eq-" + a).value.trim() || "0");
  const title = "Equation proposal: " + (prompt("A short name for this behaviour (e.g. 'magnetic snap to a point'):") || "new haptic behaviour");
  const body = `**What it should feel like:**\n\n(describe)\n\n**Equations** (as typed in the Equation lab):\n\n\`\`\`\nFx = ${src[0]}\nFy = ${src[1]}\nFz = ${src[2]}\n\`\`\`\n\n**As mathematics:**\n\n$$\n\\begin{aligned} F_x &= ${toTex(r.ast.fx)} \\\\ F_y &= ${toTex(r.ast.fy)} \\\\ F_z &= ${toTex(r.ast.fz)} \\end{aligned}\n$$\n\n**Parameters used:** k = ${P.k} N/m, b = ${P.b} N·s/m, x_d = (${P.xd.map(v => Math.round(v * 1000)).join(", ")}) mm\n\n**Proposed by:** ${myName() || "(name)"}\n`;
  sendFeedback({ kind: "equation", where: "equation lab", text: `${title}\nFx = ${src[0]}\nFy = ${src[1]}\nFz = ${src[2]}` }, true);
  window.open(`${GITHUB}/issues/new?labels=equation-proposal&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`, "_blank", "noopener");
}

// =========================================================================================== report
const REPORT_FIELDS = [["title", "Title", "Measuring the stiffness of a virtual spring with the Haply Inverse3"], ["authors", "Authors", ""],
  ["aim", "Aim — what did you want to find out?", ""], ["theory", "Theory — which equation describes the behaviour? (use $…$ for maths)", "The spring-damper (impedance) law $\\mathbf{F} = \\mathbf{K}(\\mathbf{x}_d - \\mathbf{x}) - \\mathbf{B}\\mathbf{v}$ …"],
  ["method", "Method — parameters, what you did with the handle, how many trials", ""], ["results", "Results — what do the plots and fits show? Give numbers with units", ""],
  ["discussion", "Discussion — does it match the theory? Why not exactly? What would you change?", ""], ["code", "Code — which lines implement the equation, and what would you add?", ""],
  ["conclusion", "Conclusion", ""]];
function initReport() {
  const data = store.get("report", {});
  $("#report-fields").replaceChildren(...REPORT_FIELDS.map(([k, label, ph]) => {
    const inp = k === "title" || k === "authors" ? h("input", { type: "text", placeholder: ph }) : h("textarea", { placeholder: ph });
    inp.value = data[k] || ""; inp.addEventListener("input", () => { const d = store.get("report", {}); d[k] = inp.value; store.set("report", d); });
    return h("label", { class: "field", style: "margin-bottom:10px" }, label, inp);
  }));
}
function addReportItem(item) { const items = store.get("reportItems", []); items.push({ ...item, when: new Date().toISOString() }); store.set("reportItems", items); renderReport(); }
function renderReport() {
  const items = store.get("reportItems", []);
  const box = $("#report-items");
  if (!items.length) { box.replaceChildren(h("p", { class: "note", text: "Nothing yet. Use “Add this to my report” in the Experiment and Code tabs, and “Add the current equation” below." }), addEqBtn()); return; }
  box.replaceChildren(...items.map((it, i) => h("div", { class: "card", style: "margin:8px 0" },
    h("div", { class: "row", style: "justify-content:space-between" }, h("b", { text: (it.type === "figure" ? "Figure: " : it.type === "code" ? "Code: " : "Equation: ") + it.title }),
      h("button", { class: "btn small", type: "button", onclick: () => { const a = store.get("reportItems", []); a.splice(i, 1); store.set("reportItems", a); renderReport(); } }, "Remove")),
    it.type === "figure" && it.svg ? (() => { const d = h("div"); d.innerHTML = it.svg; return d; })() : null,
    it.type === "equation" ? tex(it.tex) : null,
    it.type === "code" ? codeBlock(it.text) : null,
    it.text && it.type !== "code" ? h("p", { class: "note", text: it.text }) : null)), addEqBtn());
}
function addEqBtn() {
  return h("button", { class: "btn small", type: "button", onclick: () => { addReportItem({ type: "equation", title: PRESETS[P.preset].label, tex: eqTex(), text: "Parameters: " + eqParamsTex().replace(/\\[a-z]+|[{}]/g, " ").replace(/\s+/g, " ") }); toast("Equation added.", "good"); } }, "Add the current Play equation");
}
function reportMarkdown() {
  const d = store.get("report", {}), items = store.get("reportItems", []);
  const sec = (t, k) => (d[k] ? `## ${t}\n\n${d[k]}\n\n` : "");
  let md = `# ${d.title || "Haply lab report"}\n\n${d.authors ? "*" + d.authors + "*\n\n" : ""}`;
  md += sec("Aim", "aim") + sec("Theory", "theory");
  items.filter(i => i.type === "equation").forEach(i => (md += `$$\n${i.tex}\n$$\n\n${i.text || ""}\n\n`));
  md += sec("Method", "method") + sec("Results", "results");
  items.filter(i => i.type === "figure").forEach((i, n) => (md += `**Figure ${n + 1}.** ${i.title} (recording \`${i.source}\`, ${i.scenario}).\n\n${i.text}\n\n`));
  md += sec("Discussion", "discussion") + sec("Code", "code");
  items.filter(i => i.type === "code").forEach(i => (md += `${i.title} — ${i.link}\n\n\`\`\`cpp\n${i.text}\n\`\`\`\n\n`));
  md += sec("Conclusion", "conclusion");
  md += `---\nData and code: ${GITHUB}\n`;
  return md;
}
$("#btn-rep-md").addEventListener("click", () => { const a = h("a", { href: URL.createObjectURL(new Blob([reportMarkdown()], { type: "text/markdown" })), download: "haply-lab-report.md" }); document.body.append(a); a.click(); a.remove(); });
$("#btn-rep-html").addEventListener("click", () => {
  const items = store.get("reportItems", []);
  let html = renderMarkdown(reportMarkdown());
  const figs = items.filter(i => i.type === "figure");
  html = html.replace(/<p><strong>Figure (\d+)\.<\/strong>/g, (m, n) => (figs[n - 1] && figs[n - 1].svg ? `<div class="fig">${figs[n - 1].svg}</div>` : "") + m);
  const w = window.open("", "_blank");
  if (!w) { toast("Allow pop-ups to open the printable report.", "bad"); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Haply lab report</title><link rel="stylesheet" href="${new URL("vendor/temml/Temml-Local.css", location.href)}">
<style>body{font-family:system-ui,sans-serif;max-width:780px;margin:30px auto;padding:0 20px;line-height:1.55;color:#111}pre{background:#f3f2ef;padding:10px;border-radius:6px;overflow-x:auto;font-size:12.5px}.fig svg{max-width:100%;height:auto}h1{font-size:26px}h2{font-size:19px;margin-top:26px}.math-display{overflow-x:auto}</style></head><body>${html}<script>setTimeout(()=>print(),600)<\/script></body></html>`);
  w.document.close();
});

// =========================================================================================== terminal
let termStarted = false;
function loadScript(src) { return new Promise((res, rej) => { const s = h("script", { src }); s.onload = res; s.onerror = rej; document.head.append(s); }); }
async function initTerminal() {
  if (termStarted) return;
  if (!live() || !app.hello || !app.hello.terminal || viewOnly()) {
    $("#term").classList.add("hidden");
    $("#term-note").textContent = viewOnly() ? "The terminal needs the full lab link from your instructor (this is a watch-only link)." :
      live() ? "The terminal service is not running on this computer." : "The terminal is only available on the lab console (the link with ?key=…). On your own computer, use your own terminal and the Build it yourself tab.";
    return;
  }
  termStarted = true;
  document.head.append(h("link", { rel: "stylesheet", href: "vendor/xterm/xterm.css" }));
  try { await loadScript("vendor/xterm/xterm.js"); await loadScript("vendor/xterm/addon-fit.js"); } catch { $("#term-note").textContent = "Could not load the terminal library."; return; }
  const term = new Terminal({ fontSize: 14, cursorBlink: true, fontFamily: "ui-monospace, Consolas, Menlo, monospace", theme: { background: "#000000" } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($("#term")); fit.fit();
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/term?key=${encodeURIComponent(KEY())}`);
  ws.binaryType = "arraybuffer";
  const sendSize = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows })); };
  ws.onopen = () => { sendSize(); term.focus(); };
  ws.onmessage = ev => term.write(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data));
  ws.onclose = () => { term.write("\r\n\x1b[33m[terminal closed — reload the page to open a new one]\x1b[0m\r\n"); };
  term.onData(d => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "i", d })); });
  window.addEventListener("resize", () => { fit.fit(); sendSize(); });
  $$("[data-term]").forEach(b => b.addEventListener("click", () => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "i", d: b.dataset.term })); term.focus(); }));
  $("#term-note").textContent = "Tip: commands typed with the buttons are inserted, not run: press Enter to run them.";
}
$("#btn-release").addEventListener("click", () => { if (!live()) return; api("engine", { action: "release" }).then(() => toast("The device is free: run your program in the terminal.")).catch(e => toast(e.message, "bad")); });
$("#btn-acquire").addEventListener("click", () => { if (!live()) return; api("engine", { action: "acquire" }).then(() => toast("The console takes the device back (close your program first).")).catch(e => toast(e.message, "bad")); });

// =========================================================================================== feedback
async function sendFeedback(item, quiet) {
  if (!live()) { if (!quiet) toast("Not in the lab: use “Also open it as a GitHub issue” in the Feedback tab.", "bad"); return false; }
  if (viewOnly()) { if (!quiet) toast("A watch-only link cannot send feedback: use “Also open it as a GitHub issue” in the Feedback tab.", "bad"); return false; }
  try { await api("feedback", { ...item, page: currentTab }); if (!quiet) toast("Thanks — sent to the instructor.", "good"); return true; }
  catch (e) { toast(e.message, "bad"); return false; }
}
function fbGithub() {
  const kind = $("#fb-kind").selectedOptions[0].textContent, where = $("#fb-where").value, text = $("#fb-text").value;
  const label = { unclear: "feedback", docs: "documentation", bug: "bug", idea: "enhancement", equation: "equation-proposal" }[$("#fb-kind").value];
  $("#fb-github").href = `${GITHUB}/issues/new?labels=${label}&title=${encodeURIComponent(kind + (where ? " — " + where : ""))}&body=${encodeURIComponent(`**Where:** ${where}\n\n${text}\n\n_(sent from the lab console)_`)}`;
}
["#fb-kind", "#fb-where", "#fb-text"].forEach(s => $(s).addEventListener("input", fbGithub));
$("#fb-send").addEventListener("click", async () => {
  const text = $("#fb-text").value.trim(); if (!text) { toast("Write a message first.", "bad"); return; }
  if (await sendFeedback({ kind: $("#fb-kind").value, where: $("#fb-where").value, text })) { $("#fb-text").value = ""; $("#fb-status").textContent = "Sent. Thank you!"; refreshFeedback(); }
});
async function refreshFeedback() {
  $("#fb-where").value = $("#fb-where").value || (currentLesson ? "lesson " + currentLesson : currentFile || "");
  fbGithub();
  if (!live()) return;
  try {
    const items = (await api("feedback")).filter(i => i.kind !== "lesson-clear").slice(0, 30);
    $("#fb-list").replaceChildren(...(items.length ? items.map(i => h("div", { style: "border-bottom:1px solid var(--border);padding:6px 0" },
      h("div", { class: "small muted", text: `${i.kind} · ${i.where || ""} · ${i.time}` }), h("div", { text: i.text }))) : [h("p", { class: "note", text: "Nothing yet." })]));
  } catch {}
}

// =========================================================================================== build it yourself
function buildSetup() {
  let os = store.get("os", /Win/i.test(navigator.platform) ? "win" : /Mac/i.test(navigator.platform) ? "mac" : "pi");
  const user = () => ($("#gh-user").value.trim().replace(/[^A-Za-z0-9-]/g, "") || "YOUR-USERNAME");
  $("#gh-user").value = store.get("user", "");
  const step = (ol, html, code) => { const li = h("li"); const p = h("div"); p.innerHTML = html; li.append(p); if (code) li.append(codeBlock(code)); ol.append(li); };
  function render() {
    $$("#os-seg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.os === os)));
    const ol = $("#setup-steps"); ol.replaceChildren();
    const clone = `git clone https://github.com/${user()}/myHAPLY-PyBULLET.git\ncd myHAPLY-PyBULLET\ngit remote add upstream ${GITHUB}.git`;
    if (os === "win") {
      step(ol, "Install <b>Visual Studio 2022 or newer</b> (Community is free) with <b>Desktop development with C++</b>, and <a href='https://git-scm.com/download/win' target='_blank' rel='noopener'>Git</a>.");
      step(ol, "Fork the repository (button above), then clone <b>your</b> fork:", clone);
      step(ol, "Build everything (CMake and Ninja come with Visual Studio; no Haply software is needed):", "powershell -ExecutionPolicy Bypass -File scripts\\build_windows.ps1");
      step(ol, "Run the lab console yourself, in simulator mode (no device):", "python lab\\haply_lab.py --sim");
    } else if (os === "pi") {
      step(ol, "Install the compiler, CMake and Git:", "sudo apt-get install --no-upgrade -y g++ cmake git");
      step(ol, "Fork the repository (button above), then clone <b>your</b> fork:", clone);
      step(ol, "Build:", "cmake -S . -B build -DCMAKE_BUILD_TYPE=Release\ncmake --build build -j4");
      step(ol, "Serial port permission (then log out and back in):", "sudo usermod -aG dialout $USER");
      step(ol, "Run the lab console (add --sim if no device is connected):", "python3 lab/haply_lab.py");
    } else {
      step(ol, "Install the Xcode command-line tools and CMake:", "xcode-select --install\nbrew install cmake");
      step(ol, "Fork the repository (button above), then clone <b>your</b> fork:", clone);
      step(ol, "Build:", "cmake -S . -B build -DCMAKE_BUILD_TYPE=Release\ncmake --build build -j8");
      step(ol, "Run the lab console in simulator mode:", "python3 lab/haply_lab.py --sim");
    }
    const cl = $("#contrib-steps"); cl.replaceChildren();
    step(cl, "Start from the latest upstream code, on a new branch:", "git fetch upstream\ngit checkout -b 02-virtual-wall upstream/main");
    step(cl, "Add your example as <code>NNN-Topic/NN_short_name.cpp</code>, or improve a lesson in <code>docs/learn/</code>, then rebuild.");
    step(cl, "Commit and push to <b>your</b> fork:", "git add -A\ngit commit -m \"Add 02_virtual_wall: spring wall at z = 0\"\ngit push -u origin 02-virtual-wall");
    step(cl, `<a href="${GITHUB}/compare/main...${user()}:myHAPLY-PyBULLET:02-virtual-wall" target="_blank" rel="noopener">Open a pull request</a> from your branch into harshaturlapati/myHAPLY-PyBULLET:main.`);
  }
  $$("#os-seg button").forEach(b => b.addEventListener("click", () => { os = b.dataset.os; store.set("os", os); render(); }));
  $("#gh-user").addEventListener("input", () => { store.set("user", $("#gh-user").value.trim()); render(); });
  render();
}

// =========================================================================================== TV view
let lastTv = 0;
function renderTV(s) {
  if (performance.now() - lastTv < 150) return; lastTv = performance.now();
  const c = s.control || {};
  $("#tv-title").textContent = PRESETS[P.preset] ? PRESETS[P.preset].label : "Haply lab";
  const forces = staleInfo() ? "forces: unknown (connection lost)" : `forces ${s.on ? "ON" : "off"}`;
  $("#tv-who").textContent = c.holder ? `${c.holder} is driving · ${forces}` : `nobody in control · ${forces}`;
  const F = s.f || [0, 0, 0];
  $("#tv-nums").innerHTML = s.cal && vec3(s.x) ? `x = (${s.x.map(mm).join(", ")}) mm<br>|F| = ${fmt(norm3(F), 2)} N<br>${Math.round(s.hz || 0)} Hz` : "not calibrated";
  // with the watch-only key (the normal case for the big screen) this link lets the room watch, not drive
  $("#tv-url").textContent = live() ? `${viewOnly() ? "Watch" : "Join"}: ${location.origin}/?key=${KEY()}` : "";
}

// Browsers slow a background tab's timers down to about once per second, which would let the engine's
// watchdog cut the forces at random moments. Do it deliberately instead, and say why.
document.addEventListener("visibilitychange", () => {
  const s = app.S || {};
  if (document.hidden && live() && inControl() && s.on) { send("forces 0"); app._hiddenOff = true; }
  if (!document.hidden && app._hiddenOff) { app._hiddenOff = false; toast("Forces were switched off because this page was in the background. Switch them on again when you are holding the handle.", "bad"); }
});
// Closing (or leaving) the page while you drive: stop the forces and hand control back at once, instead of
// waiting for the watchdog and the 3 s lease. keepalive lets these requests finish while the page goes away.
window.addEventListener("pagehide", () => {
  if (!live() || !inControl()) return;
  const post = (path, body) => {
    try { fetch(`api/${path}?client=${CLIENT}`, { method: "POST", keepalive: true, headers: { "X-Lab-Key": KEY(), "Content-Type": "application/json" },
      body: JSON.stringify({ client: CLIENT, name: myName(), ...body }) }).catch(() => {}); } catch {}
  };
  if ((app.S || {}).on) post("stop", {});
  post("control", { action: "release" });
});

// =========================================================================================== init
(async function init() {
  if (VIEW_TV) { document.body.classList.add("tv"); }
  await connect();
  renderModeBanner();
  buildPlayControls(); renderPresetUI(); setupViewInput(); buildProtocols(); initEqLab(); initReport(); buildSetup();
  $$("[data-ask]").forEach(b => b.addEventListener("click", () => { $("#fb-where").value = "Play tab: " + PRESETS[P.preset].label + " equation/code"; location.hash = "tab=feedback"; }));
  startStream();
  if (VIEW_TV) { $$("section.tab").forEach(s => s.classList.toggle("hidden", s.id !== "tab-tv")); resizeCanvases(); }
  else route();
  const waitTemml = setInterval(() => { if (window.temml) { clearInterval(waitTemml); renderEquation(); eqUpdate(); if (currentLesson) openLesson(currentLesson); } }, 100);
  resizeCanvases();
})();
})();
