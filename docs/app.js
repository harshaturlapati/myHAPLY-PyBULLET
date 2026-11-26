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

let toastTimer;
function toast(text, kind = "info") {
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
// Twin of libs/myEXPR.h: same grammar, same variable names, same error messages.
const EXPR_VARS = ["x", "y", "z", "vx", "vy", "vz", "t", "xd", "yd", "zd", "kx", "ky", "kz", "bx", "by", "bz"];
const F1 = ["sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "sqrt", "abs", "sign", "step", "floor"];
const F2 = ["min", "max", "atan2", "pow"];

function parseExpr(src) {
  let pos = 0, err = null;
  const s = src;
  const skip = () => { while (pos < s.length && /\s/.test(s[pos])) pos++; };
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
  return { ast };
}
function evalAst(n, V) {
  switch (n.t) {
    case "num": return n.v;
    case "var": return V[n.name];
    case "par": return evalAst(n.a, V);
    case "neg": return -evalAst(n.a, V);
    case "bin": { const a = evalAst(n.a, V), b = evalAst(n.b, V);
      return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : n.op === "/" ? a / b : Math.pow(a, b); }
    case "call": { const a = n.args.map(x => evalAst(x, V));
      switch (n.name) {
        case "sign": return Math.sign(a[0]); case "step": return a[0] > 0 ? 1 : 0; case "abs": return Math.abs(a[0]);
        case "min": return Math.min(a[0], a[1]); case "max": return Math.max(a[0], a[1]); case "pow": return Math.pow(a[0], a[1]);
        case "clamp": return clamp(a[0], a[1], a[2]);
        default: return Math[n.name](...a);
      } }
  }
  return 0;
}
const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 };
const TEXVAR = { x: "x", y: "y", z: "z", vx: "v_x", vy: "v_y", vz: "v_z", t: "t", xd: "x_d", yd: "y_d", zd: "z_d",
  kx: "k_x", ky: "k_y", kz: "k_z", bx: "b_x", by: "b_y", bz: "b_z" };
function numStr(v) { if (Number.isInteger(v)) return String(v); return String(+v.toPrecision(6)); }
function toTex(n) {
  switch (n.t) {
    case "num": return n.pi ? "\\pi" : numStr(n.v);
    case "var": return TEXVAR[n.name];
    case "par": return `\\left(${toTex(n.a)}\\right)`;
    case "neg": return `-${toTex(n.a)}`;
    case "bin":
      if (n.op === "/") return `\\frac{${toTex(n.a)}}{${toTex(n.b)}}`;
      if (n.op === "^") return `{${toTex(n.a)}}^{${toTex(n.b)}}`;
      if (n.op === "*") return `${toTex(n.a)}\\,${toTex(n.b)}`;
      return `${toTex(n.a)} ${n.op} ${toTex(n.b)}`;
    case "call": {
      const a = n.args.map(toTex);
      if (n.name === "sqrt") return `\\sqrt{${a[0]}}`;
      if (n.name === "abs") return `\\left|${a[0]}\\right|`;
      if (n.name === "pow") return `{${a[0]}}^{${a[1]}}`;
      if (["sin", "cos", "tan", "exp", "log", "min", "max"].includes(n.name)) return `\\${n.name}\\left(${a.join(",\\ ")}\\right)`;
      return `\\operatorname{${n.name}}\\left(${a.join(",\\ ")}\\right)`;
    }
  }
  return "";
}
const CPPVAR = { x: "x.x()", y: "x.y()", z: "x.z()", vx: "v.x()", vy: "v.y()", vz: "v.z()", t: "t",
  xd: "s.x_d.x()", yd: "s.x_d.y()", zd: "s.x_d.z()", kx: "s.k.x()", ky: "s.k.y()", kz: "s.k.z()", bx: "s.b.x()", by: "s.b.y()", bz: "s.b.z()" };
function toCpp(n) {
  switch (n.t) {
    case "num": return n.pi ? "M_PI" : (Number.isInteger(n.v) ? n.v + ".0" : String(n.v));
    case "var": return CPPVAR[n.name];
    case "par": return `(${toCpp(n.a)})`;
    case "neg": return `-${toCpp(n.a)}`;
    case "bin": return n.op === "^" ? `std::pow(${toCpp(n.a)}, ${toCpp(n.b)})` : `${toCpp(n.a)} ${n.op} ${toCpp(n.b)}`;
    case "call": {
      const a = n.args.map(toCpp);
      if (n.name === "step") return `(${a[0]} > 0.0 ? 1.0 : 0.0)`;
      if (n.name === "sign") return `double((${a[0]} > 0) - (${a[0]} < 0))`;
      if (n.name === "clamp") return `std::clamp(${a.join(", ")})`;
      if (n.name === "min" || n.name === "max") return `std::${n.name}(${a.join(", ")})`;
      return `std::${n.name}(${a.join(", ")})`;
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
class LocalSim {
  constructor() {
    this.t0 = performance.now() / 1000; this.tl = 0;
    this.x = [0, 0, 0]; this.v = [0, 0, 0]; this.F = [0, 0, 0]; this.e = [0, 0, 0]; this.hand = [0, 0, 0];
    this.scn = { kind: "free", xd: [0, 0, 0], rpy: [0, 0, 0], k: [0, 0, 0], b: [0, 0, 0], ast: {} };
    this.tgt = { xd: [0, 0, 0], rpy: [0, 0, 0], k: [0, 0, 0], b: [0, 0, 0] };
    this.src = { fx: "", fy: "", fz: "" };
    this.fmax = 2; this.on = false; this.ramp = 0; this.msg = "simulator: drag in the views to move the virtual hand"; this.msg_id = 1;
    this.drag = null; this.dragUntil = 0; this.rec = null; this.recs = []; this.lastFile = "";
  }
  setMsg(m) { this.msg = m; this.msg_id++; }
  handle(c) {
    const p = c.split(" ");
    if (p[0] === "forces") { this.on = p[1] === "1"; this.ramp = 0; this.setMsg(this.on ? "forces ON (fading in over 1 s)" : "forces off"); }
    else if (p[0] === "set") {
      if (p[1] === "kind") { if (this.scn.kind !== p[2]) { this.scn.kind = p[2]; this.ramp = 0; this.setMsg("scenario: " + p[2]); } }
      else if (p[1] === "fmax") this.fmax = clamp(+p[2], 0, 4);
      else { const v = p.slice(2, 5).map(Number);
        if (p[1] === "xd") this.tgt.xd = v.map(a => clamp(a, -0.3, 0.3));
        if (p[1] === "rpy") this.tgt.rpy = v;
        if (p[1] === "k") this.tgt.k = v.map(a => clamp(a, 0, 1000));
        if (p[1] === "b") this.tgt.b = v.map(a => clamp(a, 0, 15)); }
    } else if (p[0] === "expr") {
      const axis = p[1], text = p.slice(2).join(" ").trim();
      if (!text || text === "0") { delete this.scn.ast[axis]; this.src[axis] = ""; return; }
      const r = parseExpr(text);
      if (r.err) { this.setMsg(axis + ": " + r.err); return; }
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
      const r = forceOf(s, this.x, this.v, t); this.e = r.e;
      let F = [0, 0, 0];
      if (this.on) { this.ramp = Math.min(1, this.ramp + dt); F = r.F.map(f => f * this.ramp); const m = norm3(F);
        if (!Number.isFinite(m)) F = [0, 0, 0]; else if (m > this.fmax) F = F.map(f => f * this.fmax / m); } else this.ramp = 0;
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
      par: { kind: this.scn.kind, xd: this.tgt.xd, rpy: this.tgt.rpy, k: this.tgt.k, b: this.tgt.b, fmax: this.fmax, xd_now: this.scn.xd, k_now: this.scn.k, ...this.src },
      control: { holder: "you", you: true, watching: 1, names: [] } };
  }
}

// =========================================================================================== connection
const params = new URLSearchParams(location.search);
if (params.get("key")) { store.set("key", params.get("key")); }
const VIEW_TV = params.get("view") === "tv";
if (params.get("key") && !VIEW_TV) { params.delete("key"); history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : "") + location.hash); }
const KEY = () => store.get("key", "");
const CLIENT = sessionStorage.getItem("myhaply.client") || (() => { const c = Math.random().toString(36).slice(2, 12); sessionStorage.setItem("myhaply.client", c); return c; })();

const app = { mode: "connecting", hello: null, S: null, sim: null, lastMsgId: -1, es: null, files: null };
const live = () => app.mode === "live";

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
  } catch { app.mode = "sim"; }
}

function startStream() {
  if (live()) {
    const open = () => {
      app.es = new EventSource("api/stream?key=" + encodeURIComponent(KEY()) + "&client=" + CLIENT);
      app.es.onmessage = ev => { try { onState(JSON.parse(ev.data)); } catch {} };
      app.es.onerror = () => { app.es.close(); setTimeout(open, 1500); };
    };
    open();
    setInterval(() => api("ping", {}).then(c => { if (app.S) app.S.control = c; renderChips(); }).catch(() => {}), 400);
  } else {
    app.sim = new LocalSim();
    presetCommands().forEach(c => app.sim.handle(c));      // start the simulator with the page's saved settings
    const tick = () => { onState(app.sim.step()); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
}

function send(cmds) {
  if (!Array.isArray(cmds)) cmds = [cmds];
  if (!live()) { cmds.forEach(c => app.sim.handle(c)); return Promise.resolve(); }
  return api("cmd", { cmds }).catch(e => toast(e.message, "bad"));
}
const inControl = () => !live() || !!(app.S && app.S.control && app.S.control.you);
const myName = () => ($("#my-name").value || "").trim();

// =========================================================================================== state + chips
const trail = { top: [], n: 0 };
function onState(s) {
  app.S = s;
  if (s.msg_id !== undefined && s.msg_id !== app.lastMsgId) {
    if (app.lastMsgId >= 0 && s.msg) toast(s.msg, /off:|cannot|lost|unknown|error/i.test(s.msg) ? "bad" : "info");
    app.lastMsgId = s.msg_id;
  }
  if (s.x && s.cal) { trail.top.push(s.x.slice()); if (trail.top.length > 150) trail.top.shift(); }
  if (s.par) adoptEngineParams(s.par);
  frame();
}

let lastChips = 0;
function renderChips() {
  const s = app.S || {};
  const c = s.control || {};
  const chips = [];
  const chip = (cls, text) => chips.push(h("span", { class: "chip " + cls }, h("i"), text));
  if (app.mode === "needkey") chip("bad", "needs the lab key");
  else if (!live()) chip("warn", "simulator (no device)");
  else if (s.sim) chip("warn", "lab engine: simulator");
  else if (s.released) chip("warn", "device released to a program");
  else chip(s.connected ? "good" : "bad", s.connected ? "Inverse3 #" + s.dev : "no device");
  if (live() && s.connected && !s.sim) chip(s.cal ? "good" : "bad", s.cal ? "calibrated" : "NOT calibrated");
  chip(s.on ? "good" : "", s.on ? `forces ON${s.ramp < 1 ? " " + Math.round(s.ramp * 100) + "%" : ""}` : "forces off");
  if (s.hz) chip("", Math.round(s.hz) + " Hz");
  if (live()) chip(c.you ? "good" : c.holder ? "warn" : "", c.you ? "you are in control" : c.holder ? "in control: " + c.holder : "nobody in control");
  if (live() && c.watching) chip("", c.watching + " watching");
  if (s.rec) chip("rec", "REC " + fmt(s.rec_s, 1) + " s");
  $("#chips").replaceChildren(...chips);
  const btn = $("#control-btn");
  btn.classList.toggle("hidden", !live());
  btn.textContent = c.you ? "Release control" : "Take control";
  btn.classList.toggle("primary", !c.you);
}

$("#control-btn").addEventListener("click", async () => {
  const c = (app.S && app.S.control) || {};
  if (c.you) { await api("control", { action: "release" }).catch(e => toast(e.message, "bad")); return; }
  if (!myName()) {
    const inp = h("input", { type: "text", placeholder: "First name", maxlength: "40" });
    const ok = await modal("Your name", h("div", {}, h("p", { class: "note", text: "Shown to others while you drive the device." }), inp),
      [{ label: "Cancel", value: false }, { label: "OK", cls: "primary", value: true }]);
    if (!ok || !inp.value.trim()) return;
    $("#my-name").value = inp.value.trim(); store.set("name", inp.value.trim());
  }
  try { await api("control", { action: "take" }); toast("You are in control. Others can watch."); }
  catch (e) { toast(e.status === 409 ? `${e.body && e.body.holder} is driving the device right now. Ask them to release control.` : e.message, "bad"); }
});
$("#my-name").value = store.get("name", "");
$("#my-name").addEventListener("change", e => store.set("name", e.target.value.trim()));

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
const P = Object.assign({ preset: "free", k: 200, b: 2, fmax: 2, xd: [0, 0, 0], rpy: [0, 0, 0], fx: "-kx*(x - xd) - bx*vx", fy: "-ky*(y - yd) - by*vy", fz: "-kz*(z - zd) - bz*vz" },
  store.get("P", {}));
let userEditedAt = 0;

function presetCommands() {
  const K = P.k, B = P.b;
  const kb = { spring: [[K, K, K], [B, B, B]], line: [[K, K, 0], [B, B, 0]], plane: [[0, 0, K], [0, 0, B]], wall: [[0, 0, K], [0, 0, B]],
    damping: [[0, 0, 0], [B, B, B]], custom: [[K, K, K], [B, B, B]], free: [[0, 0, 0], [0, 0, 0]] }[P.preset];
  const kind = { free: "free", wall: "wall", custom: "custom" }[P.preset] || "impedance";
  const c = [`set kind ${kind}`, `set k ${kb[0].join(" ")}`, `set b ${kb[1].join(" ")}`,
    `set xd ${P.xd.map(v => v.toFixed(5)).join(" ")}`, `set rpy ${P.rpy.map(v => rad(v).toFixed(5)).join(" ")}`, `set fmax ${P.fmax}`];
  if (P.preset === "custom") ["fx", "fy", "fz"].forEach(a => c.push(`expr ${a} ${P[a] || "0"}`));
  return c;
}
let sendTimer;
function pushParams() {
  store.set("P", P); userEditedAt = performance.now();
  renderEquation(); renderPresetUI();
  if (!inControl()) return;
  clearTimeout(sendTimer); sendTimer = setTimeout(() => send(presetCommands()), 60);
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
  if (par.kind === "custom") ["fx", "fy", "fz"].forEach(a => { if (par[a]) P[a] = par[a]; });
  if (inControl()) app._adopted = true;
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
  ["x", "y", "z"].forEach((a, i) => $("#xd-" + a).addEventListener("change", e => { P.xd[i] = (+e.target.value || 0) / 1000; pushParams(); }));
  $("#btn-xd-here").addEventListener("click", () => { if (app.S && app.S.x) { P.xd = app.S.x.slice(); pushParams(); toast("Target placed at the cursor."); } });
  $("#btn-forces").addEventListener("click", toggleForces);
  $("#btn-center").addEventListener("click", () => { if (app.S) viewState.c = app.S.x.slice(); });
  $("#btn-zoom-in").addEventListener("click", () => (viewState.half = Math.max(0.02, viewState.half / 1.5)));
  $("#btn-zoom-out").addEventListener("click", () => (viewState.half = Math.min(0.4, viewState.half * 1.5)));
  $("#btn-open-code").addEventListener("click", () => { location.hash = "tab=code"; setTimeout(() => openFile("libs/myHAPLY_SCENARIOS.h"), 50); });
  const tvUrl = live() ? `${location.origin}/?key=${encodeURIComponent(KEY())}&view=tv` : `${location.pathname}?view=tv`;
  $("#lnk-tv").href = tvUrl;
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

async function toggleForces() {
  const s = app.S || {};
  if (!inControl()) { toast("Take control first (button at the top right).", "bad"); return; }
  if (s.on) { send("forces 0"); return; }
  if (live() && !s.sim) {
    if (!s.cal) { toast("Calibrate the device first: rest the cursor on the magnetic dock until the LED changes colour.", "bad"); return; }
    if (!app._forceConfirmed) {
      const boxes = ["The motor power cable is plugged in (feedback works without it; forces need it).",
        "I am holding the handle firmly.", "Nobody's face or fingers are near the arms.",
        "I know: the red button on this page (or closing the page) switches forces off within 2 s."].map(t => h("label", {}, h("input", { type: "checkbox" }), h("span", { text: t })));
      const body = h("div", {}, ...boxes);
      const ok = await modal("Before forces go on", body, [{ label: "Cancel", value: false },
        { label: "Switch forces on", cls: "primary", value: true, check: () => { const all = $$("input", body).every(c => c.checked); if (!all) toast("Tick all four boxes first.", "bad"); return all; } }]);
      if (!ok) return;
      app._forceConfirmed = true;
    }
  }
  await send(presetCommands());
  send("forces 1");
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
  const kind = par.kind || "free", xd = par.xd_now || par.xd || [0, 0, 0], R = R_from_rpy(par.rpy || [0, 0, 0]);
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
      if ($("#chk-place").checked) { if (!inControl()) { toast("Take control first.", "bad"); return; } const p = toWorld(ev); P.xd[a] = p[a]; P.xd[b] = p[b]; pushParams(); return; }
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
  const btn = $("#btn-forces");
  btn.textContent = s.on ? "Forces are ON — switch off" : "Forces are OFF — switch on";
  btn.className = "btn big forcebtn " + (s.on ? "danger" : "good");
  btn.disabled = !inControl();
  $("#force-note").textContent = !inControl() ? "Take control (top right) to change anything. You can still watch." :
    live() && !s.sim && !s.cal ? "The device is not calibrated: forces cannot go on." :
    s.on ? `Force limit ${fmt((s.par || {}).fmax || P.fmax, 1)} N. Closing this page also switches forces off within 2 s.` :
    "Forces fade in over 1 s. Start with small k (100–200 N/m).";
  $("#drag-hint").textContent = live() && !s.sim ? "Move the real handle." : "Drag in a view to move the virtual hand.";
  $("#scale-top").textContent = $("#scale-side").textContent = `±${Math.round(viewState.half * 100)} cm`;
}

function frame() {
  const s = app.S; if (!s) return;
  if (performance.now() - lastChips > 250) { renderChips(); lastChips = performance.now(); renderStartSteps(); }
  // keep the cursor in view
  if (s.cal && s.x) for (let i = 0; i < 3; i++) if (Math.abs(s.x[i] - viewState.c[i]) > viewState.half * 0.8) viewState.c[i] = s.x[i];
  if (currentTab === "play" || VIEW_TV) { canvases.forEach(([cv, ax]) => drawView(cv, ax, s)); if (!VIEW_TV) renderReadout(s); else renderTV(s); }
  if (currentTab === "experiment") renderRecStatus(s);
}

// =========================================================================================== try links
function applyTry(hp) {
  const preset = hp.get("try");
  if (!PRESETS[preset]) { showTab("play"); return; }
  P.preset = preset;
  if (hp.has("k")) P.k = clamp(+hp.get("k") || 0, 0, 800);
  if (hp.has("b")) P.b = clamp(+hp.get("b") || 0, 0, 10);
  if (hp.has("rpy")) P.rpy = hp.get("rpy").split(",").map(v => +v || 0).concat([0, 0, 0]).slice(0, 3);
  if (hp.get("xd") === "here" && app.S && app.S.x) P.xd = app.S.x.slice();
  else if (hp.has("xd")) P.xd = hp.get("xd").split(",").map(v => (+v || 0) / 1000).concat([0, 0, 0]).slice(0, 3);
  ["fx", "fy", "fz"].forEach(a => { if (hp.has(a)) P[a] = hp.get(a); });
  history.replaceState(null, "", "#tab=play");
  showTab("play");
  pushParams();
  if (!inControl()) toast("Take control (top right) to load this on the device. You can still read the equation.");
  else toast(`Loaded: ${PRESETS[preset].label}. Switch forces on when you are holding the handle.`);
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
    { done: inControl(), title: "Take control", text: live() ? (c.holder && !c.you ? `${c.holder} is driving now. Ask them to release, or just watch.` : "Press “Take control” at the top right. One person drives at a time; everyone can watch.") : "In the simulator you are always in control." },
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
  } else b.replaceChildren();
  $("#mode-label").textContent = app.mode === "live" ? "live on " + (app.hello ? app.hello.host : "the lab Pi") : app.mode === "sim" ? "simulator" : "";
  $("#nav-foot").replaceChildren(h("a", { href: GITHUB, target: "_blank", rel: "noopener", text: "GitHub repository" }), h("br"), h("a", { href: PAGES, target: "_blank", rel: "noopener", text: "Public simulator" }));
}

// =========================================================================================== experiment
const PROTOCOLS = [
  { id: "spring", title: "Measure the spring constant", try: "try=spring&k=200&b=1&xd=here", label: "spring-k200",
    steps: ["Load the spring at the cursor (button) and switch forces on.", "Start recording.", "Pull the handle slowly 1 cm to the right, hold 2 s; then 2 cm; then 3 cm. Let go back to the centre each time.", "Stop recording, press Analyse, choose e1 → f1."],
    q: "Is the slope close to 200 N/m? Why would it be a bit lower (hint: the force limit, your hand, the 1 s fade-in)?" },
  { id: "damping", title: "What does damping do?", try: "try=damping&b=4", label: "damping-b4",
    steps: ["Load the damping field and switch forces on.", "Record while you move the handle slowly, then quickly, left and right.", "Analyse VX → f1."],
    q: "The points should lie on a line through zero. What is its slope, and what sign does it have? Why?" },
  { id: "wall", title: "Wall stiffness and buzz", try: "try=wall&k=300&b=0&xd=here", label: "wall-k300-b0",
    steps: ["Load the wall just below the cursor (move the target 1 cm down after loading).", "Record while you tap the wall lightly 5 times.", "Repeat with k = 800, b = 0, then k = 800, b = 3 (new recordings).", "Compare e3 and f3 over time."],
    q: "Which setting buzzes? What did damping change in the plot? (Lesson 6 explains why.)" },
  { id: "line", title: "Follow a line (virtual fixture)", try: "try=line&k=300&b=2&xd=here&rpy=0,90,0", label: "line-guide-on",
    steps: ["Record 10 s tracing a straight line left-right with forces OFF.", "Load the line guide (pitch 90° turns the line to point along X), forces ON, record again.", "Analyse e2 and e3 (sideways error) in both."],
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
async function recText(r) { return live() ? (await fetch(`api/recordings/${encodeURIComponent(r.name)}?key=${encodeURIComponent(KEY())}`)).text() : r.csv; }
async function downloadRec(r) {
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
    try { lessons = await (await fetch("learn/index.json")).json(); } catch { lessons = []; }
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
  if (!annotations) { try { annotations = await (await fetch("learn/annotations.json")).json(); } catch { annotations = {}; } }
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
  { n: "Floor at the target height (wall with step)", fx: "0", fy: "0", fz: "step(zd - z)*kz*(zd - z) - step(zd - z)*bz*vz" },
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
    ["fx", "fy", "fz"].forEach(a => (P[a] = $("#eq-" + a).value.trim() || "0"));
    P.preset = "custom"; if (!P.k) P.k = 200;
    pushParams(); location.hash = "tab=play";
    toast("Loaded as “My equation”. Switch forces on in Play when you are holding the handle.");
  });
  $("#btn-eq-propose").addEventListener("click", proposeEquation);
}
function eqParse() {
  const out = { ok: true, ast: {}, err: {} };
  ["fx", "fy", "fz"].forEach(a => { const src = $("#eq-" + a).value.trim() || "0"; const r = parseExpr(src); if (r.err) { out.ok = false; out.err[a] = r.err; } else out.ast[a] = r.ast; });
  return out;
}
function eqUpdate() {
  if (!$("#eq-fx")) return;
  const r = eqParse();
  $("#eq-errors").replaceChildren(...Object.entries(r.err).map(([a, e]) => status("bad", `F${a[1]}: ${e}`)));
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
  if (!live() || !app.hello || !app.hello.terminal) {
    $("#term").classList.add("hidden");
    $("#term-note").textContent = live() ? "The terminal service is not running on this computer." : "The terminal is only available on the lab console (the link with ?key=…). On your own computer, use your own terminal and the Build it yourself tab.";
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
  $("#tv-who").textContent = c.holder ? `${c.holder} is driving · forces ${s.on ? "ON" : "off"}` : `nobody in control · forces ${s.on ? "ON" : "off"}`;
  const F = s.f || [0, 0, 0];
  $("#tv-nums").innerHTML = s.cal ? `x = (${s.x.map(mm).join(", ")}) mm<br>|F| = ${fmt(norm3(F), 2)} N<br>${Math.round(s.hz || 0)} Hz` : "not calibrated";
  $("#tv-url").textContent = live() ? `Join: ${location.origin}/?key=${KEY()}` : "";
}

// Browsers slow a background tab's timers down to about once per second, which would let the engine's
// watchdog cut the forces at random moments. Do it deliberately instead, and say why.
document.addEventListener("visibilitychange", () => {
  const s = app.S || {};
  if (document.hidden && live() && inControl() && s.on) { send("forces 0"); app._hiddenOff = true; }
  if (!document.hidden && app._hiddenOff) { app._hiddenOff = false; toast("Forces were switched off because this page was in the background. Switch them on again when you are holding the handle.", "bad"); }
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
