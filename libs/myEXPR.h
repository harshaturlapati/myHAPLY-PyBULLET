// myEXPR.h - a tiny, safe expression compiler for student-written force equations.
//
//   my::Expr fx;
//   std::string err;
//   if (!fx.compile("-kx*(x - xd) - bx*vx", err)) puts(err.c_str());
//   double vars[my::Expr::N_VARS] = {...};          // filled every 1 ms by the lab engine
//   double Fx = fx.eval(vars);
//
// Grammar:  numbers, + - * / ^, parentheses, the variables listed in VAR_NAMES, the constant pi, and
//           sin cos tan asin acos atan exp log sqrt abs sign step floor   (one argument)
//           min max atan2 pow                                           (two arguments)
//           clamp(value, lo, hi)                                        (three arguments)
// step(a) is 1 when a > 0, else 0: handy for one-sided forces such as walls.
// clamp(v, lo, hi) is min(max(v, lo), hi), so if lo > hi by mistake the result is always hi.
// Numbers are plain decimals: 12  1.5  1.  .5  2e-3  (no hex such as 0x10, no "inf" or "nan").
// The expression is compiled once into a short stack program, so evaluating it inside the 1 kHz loop
// costs well under a microsecond and never allocates memory. The same grammar is implemented in
// docs/app.js so the web page can check and preview an equation before it is sent to the device:
// same numbers, names, error messages and the same 32-slot stack limit. Evaluation follows JavaScript
// too: if any input of min, max, clamp, sign, pow or ^ is NaN ("not a number"), the result is NaN, which
// the lab engine turns into zero force.
#pragma once

#include <cctype>
#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>

namespace my {

class Expr {
public:
    // Variables a student may use. Order matters: it is the layout of the vars[] array.
    enum Var { X, Y, Z, VX, VY, VZ, T, XD, YD, ZD, KX, KY, KZ, BX, BY, BZ, N_VARS };
    static const char* const* var_names() {
        static const char* const names[N_VARS] = {"x", "y", "z", "vx", "vy", "vz", "t", "xd", "yd", "zd",
                                                  "kx", "ky", "kz", "bx", "by", "bz"};
        return names;
    }

    bool empty() const { return prog_.empty(); }
    const std::string& source() const { return src_; }

    // Compile `text`. On error returns false and explains where in `err`; the previous program is kept.
    bool compile(const std::string& text, std::string& err) {
        std::vector<Op> out;
        Parser p{text, 0, out, ""};
        p.skip();
        if (p.pos >= text.size()) { err = "empty equation"; return false; }
        if (!p.expr() || (p.skip(), p.pos != text.size())) {
            err = p.err.empty() ? "unexpected '" + text.substr(p.pos, 1) + "' at position " + std::to_string(p.pos + 1)
                                : p.err;
            return false;
        }
        // stack depth check (also guarantees eval() never overflows its fixed stack)
        int depth = 0, max_depth = 0;
        for (const Op& o : out) {
            depth += o.stack_change();
            if (depth > max_depth) max_depth = depth;
        }
        if (max_depth > STACK) { err = "equation is too deeply nested"; return false; }
        prog_ = std::move(out);
        src_ = text;
        return true;
    }

    void clear() { prog_.clear(); src_.clear(); }

    double eval(const double* vars) const {
        if (prog_.empty()) return 0.0;
        double st[STACK];
        int sp = 0;
        for (const Op& o : prog_) {
            switch (o.code) {
                case PUSH_NUM: st[sp++] = o.num; break;
                case PUSH_VAR: st[sp++] = vars[o.arg]; break;
                case NEG: st[sp - 1] = -st[sp - 1]; break;
                case ADD: sp--; st[sp - 1] += st[sp]; break;
                case SUB: sp--; st[sp - 1] -= st[sp]; break;
                case MUL: sp--; st[sp - 1] *= st[sp]; break;
                case DIV: sp--; st[sp - 1] /= st[sp]; break;
                case POW: sp--; st[sp - 1] = pow_js(st[sp - 1], st[sp]); break;
                case FN1: st[sp - 1] = fn1(o.arg, st[sp - 1]); break;
                case FN2: sp--; st[sp - 1] = fn2(o.arg, st[sp - 1], st[sp]); break;
                case FN3: sp -= 2; st[sp - 1] = clamp3(st[sp - 1], st[sp], st[sp + 1]); break;
            }
        }
        return sp == 1 ? st[0] : 0.0;
    }

private:
    static constexpr int STACK = 32;
    enum Code { PUSH_NUM, PUSH_VAR, NEG, ADD, SUB, MUL, DIV, POW, FN1, FN2, FN3 };
    struct Op {
        Code code;
        int arg;
        double num;
        int stack_change() const {
            switch (code) {
                case PUSH_NUM: case PUSH_VAR: return 1;
                case NEG: case FN1: return 0;
                case FN3: return -2;
                default: return -1;
            }
        }
    };

    // The small functions below behave like JavaScript's Math.min, Math.max, Math.sign and Math.pow, so the
    // device and the page's preview give the same answer even for NaN. (C++'s own a < b ? a : b would quietly
    // return b when a is NaN.)
    static double min_js(double a, double b) { return (std::isnan(a) || std::isnan(b)) ? NAN : (a < b ? a : b); }
    static double max_js(double a, double b) { return (std::isnan(a) || std::isnan(b)) ? NAN : (a > b ? a : b); }
    static double pow_js(double a, double b) {
        // C++ says pow(1, NaN) = 1 and pow(-1, inf) = 1; JavaScript says NaN for both
        if (std::isnan(b) || (std::isinf(b) && std::fabs(a) == 1.0)) return NAN;
        return std::pow(a, b);
    }
    static double fn1(int f, double a) {
        switch (f) {
            case 0: return std::sin(a);   case 1: return std::cos(a);   case 2: return std::tan(a);
            case 3: return std::asin(a);  case 4: return std::acos(a);  case 5: return std::atan(a);
            case 6: return std::exp(a);   case 7: return std::log(a);   case 8: return std::sqrt(a);
            case 9: return std::fabs(a);  case 10: return std::isnan(a) ? a : (double)((a > 0) - (a < 0));
            case 11: return a > 0 ? 1.0 : 0.0;  case 12: return std::floor(a);
        }
        return 0.0;
    }
    static double fn2(int f, double a, double b) {
        switch (f) {
            case 0: return min_js(a, b);  case 1: return max_js(a, b);
            case 2: return std::atan2(a, b);  case 3: return pow_js(a, b);
        }
        return 0.0;
    }
    static double clamp3(double v, double lo, double hi) { return min_js(max_js(v, lo), hi); }   // lo > hi gives hi

    struct Parser {
        const std::string& s;
        size_t pos;
        std::vector<Op>& out;
        std::string err;

        void skip() { while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++; }   // " \t\n\v\f\r"
        bool digit_at(size_t i) const { return i < s.size() && s[i] >= '0' && s[i] <= '9'; }
        bool eat(char c) { skip(); if (pos < s.size() && s[pos] == c) { pos++; return true; } return false; }
        bool fail(const std::string& m) { if (err.empty()) err = m + " at position " + std::to_string(pos + 1); return false; }

        bool expr() {                                   // term (('+'|'-') term)*
            if (!term()) return false;
            for (;;) {
                if (eat('+')) { if (!term()) return false; out.push_back({ADD, 0, 0}); }
                else if (eat('-')) { if (!term()) return false; out.push_back({SUB, 0, 0}); }
                else return true;
            }
        }
        bool term() {                                   // unary (('*'|'/') unary)*
            if (!unary()) return false;
            for (;;) {
                if (eat('*')) { if (!unary()) return false; out.push_back({MUL, 0, 0}); }
                else if (eat('/')) { if (!unary()) return false; out.push_back({DIV, 0, 0}); }
                else return true;
            }
        }
        bool unary() {                                  // ('-'|'+') unary | power
            if (eat('-')) { if (!unary()) return false; out.push_back({NEG, 0, 0}); return true; }
            if (eat('+')) return unary();
            return power();
        }
        bool power() {                                  // primary ('^' unary)?   (right-associative)
            if (!primary()) return false;
            if (eat('^')) { if (!unary()) return false; out.push_back({POW, 0, 0}); }
            return true;
        }
        bool primary() {
            skip();
            if (pos >= s.size()) return fail("equation ends too early");
            const char c = s[pos];
            if (c == '(') { pos++; if (!expr()) return false; if (!eat(')')) return fail("missing ')'"); return true; }
            if (std::isdigit((unsigned char)c) || (c == '.' && digit_at(pos + 1))) {
                // digits [. digits]  or  . digits,  then an optional exponent e[+-]digits
                // (scanned by hand: strtod alone would also accept hex such as 0x10, which the page rejects)
                size_t e = pos;
                while (digit_at(e)) e++;
                if (e < s.size() && s[e] == '.') { e++; while (digit_at(e)) e++; }
                if (e < s.size() && (s[e] == 'e' || s[e] == 'E')) {
                    size_t x = e + 1;
                    if (x < s.size() && (s[x] == '+' || s[x] == '-')) x++;
                    if (digit_at(x)) { while (digit_at(x)) x++; e = x; }   // "2e" without digits: the number is 2
                }
                const double v = std::strtod(s.substr(pos, e - pos).c_str(), nullptr);
                pos = e;
                out.push_back({PUSH_NUM, 0, v});
                return true;
            }
            if (std::isalpha((unsigned char)c) || c == '_') {
                const size_t start = pos;
                while (pos < s.size() && (std::isalnum((unsigned char)s[pos]) || s[pos] == '_')) pos++;
                const std::string name = s.substr(start, pos - start);
                skip();
                if (pos < s.size() && s[pos] == '(') return call(name, start);
                if (name == "pi") { out.push_back({PUSH_NUM, 0, 3.14159265358979323846}); return true; }
                for (int i = 0; i < N_VARS; i++)
                    if (name == var_names()[i]) { out.push_back({PUSH_VAR, i, 0}); return true; }
                pos = start;
                return fail("unknown name '" + name + "'");
            }
            return fail("unexpected '" + std::string(1, c) + "'");
        }
        bool call(const std::string& name, size_t start) {
            static const char* f1[] = {"sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "sqrt", "abs",
                                       "sign", "step", "floor"};
            static const char* f2[] = {"min", "max", "atan2", "pow"};
            int kind = 0, id = -1;
            for (int i = 0; i < 13; i++) if (name == f1[i]) { kind = 1; id = i; }
            for (int i = 0; i < 4; i++) if (name == f2[i]) { kind = 2; id = i; }
            if (name == "clamp") { kind = 3; id = 0; }
            if (kind == 0) { pos = start; return fail("unknown function '" + name + "'"); }
            eat('(');
            for (int a = 0; a < kind; a++) {
                if (a > 0 && !eat(',')) return fail("'" + name + "' needs " + std::to_string(kind) + " arguments");
                if (!expr()) return false;
            }
            if (!eat(')')) return fail("missing ')' after the arguments of '" + name + "'");
            out.push_back({kind == 1 ? FN1 : kind == 2 ? FN2 : FN3, id, 0});
            return true;
        }
    };

    std::vector<Op> prog_;
    std::string src_;
};

}  // namespace my
