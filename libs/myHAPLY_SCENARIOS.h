// myHAPLY_SCENARIOS.h - the haptic interaction equations of the lab, written with Eigen so the code reads
// like the maths. Read this file next to the "Learn" and "Play" tabs of the lab page.
//
//   x  cursor position (m)          v  cursor velocity (m/s)          F  force sent to the device (N)
//   x_d target point (m)            R  orientation of the target frame (rotation matrix, from roll-pitch-yaw)
//   K = diag(kx, ky, kz)  stiffness (N/m)      B = diag(bx, by, bz)  damping (N s/m)   both along the target frame
//
// 1. IMPEDANCE (spring + damper), written in the target frame and rotated back into the device frame:
//
//        e = R^T (x_d - x)          position error, seen from the target frame
//        u = R^T v                  velocity, seen from the target frame
//        F = R ( K e - B u )
//
//    One equation, many behaviours - only K and B change:
//        spring to a point   K = diag(k, k, k)      pulls x towards x_d along every direction
//        line guide          K = diag(k, k, 0)      free along the frame's z axis, pulled onto that line
//        plane guide         K = diag(0, 0, k)      free in the frame's x-y plane, pulled onto that plane
//        damping field       K = 0, B = diag(b,b,b) resists motion, like moving through honey
//
// 2. WALL (one-sided spring): the wall is the plane through x_d whose outward normal is n = R * (0,0,1).
//        d = n . (x_d - x)          penetration depth (> 0 when the cursor is inside the wall)
//        F = max(0, kz d - bz (n . v)) n    if d > 0,   F = 0 otherwise
//    max(0, ...) makes sure the wall only ever pushes you out, never pulls you in.
//
// 3. CUSTOM: three expressions Fx, Fy, Fz typed by a student (see myEXPR.h), e.g. a spring
//        Fx = -kx*(x - xd) - bx*vx
//
// Safety is NOT in this file on purpose: the lab engine clamps |F| to F_max, ramps forces in, and switches
// them off if the cursor moves too fast or the page stops answering. Keep equations here pure maths.
#pragma once

#include <Eigen/Dense>
#include <algorithm>
#include <string>

#include "myEXPR.h"

namespace haptics {

using Vec3 = Eigen::Vector3d;
using Mat3 = Eigen::Matrix3d;

// Rotation matrix from roll, pitch, yaw (radians), Z-Y-X convention:  R = Rz(yaw) * Ry(pitch) * Rx(roll)
// Each AngleAxis is "turn by this angle about this axis"; multiplying them chains the turns.
inline Mat3 R_from_rpy(const Vec3& rpy) {
    return (Eigen::AngleAxisd(rpy.z(), Vec3::UnitZ()) *
            Eigen::AngleAxisd(rpy.y(), Vec3::UnitY()) *
            Eigen::AngleAxisd(rpy.x(), Vec3::UnitX())).toRotationMatrix();
}

enum class Kind { Free, Impedance, Wall, Custom };

inline const char* kind_name(Kind k) {
    switch (k) {
        case Kind::Free: return "free";
        case Kind::Impedance: return "impedance";
        case Kind::Wall: return "wall";
        case Kind::Custom: return "custom";
    }
    return "free";
}
inline bool kind_from_name(const std::string& s, Kind& k) {
    if (s == "free") k = Kind::Free;
    else if (s == "impedance") k = Kind::Impedance;
    else if (s == "wall") k = Kind::Wall;
    else if (s == "custom") k = Kind::Custom;
    else return false;
    return true;
}

struct Scenario {
    Kind kind = Kind::Free;
    Vec3 x_d = Vec3::Zero();   // target point / a point on the line, plane or wall (m)
    Vec3 rpy = Vec3::Zero();   // orientation of the target frame (rad)
    Vec3 k = Vec3::Zero();     // stiffness along the target frame axes (N/m)
    Vec3 b = Vec3::Zero();     // damping along the target frame axes (N s/m)
    my::Expr fx, fy, fz;       // custom equations (Kind::Custom)
};

// Extra quantities that are useful to plot and log
struct Detail {
    Vec3 e = Vec3::Zero();     // position error in the target frame, e = R^T (x_d - x)   (for a wall, e.z() = d)
};

// THE function: force for scenario s at position x, velocity v and time t (s).
inline Vec3 force(const Scenario& s, const Vec3& x, const Vec3& v, double t, Detail* detail = nullptr) {
    const Mat3 R = R_from_rpy(s.rpy);
    const Vec3 e = R.transpose() * (s.x_d - x);     // position error, target frame
    const Vec3 u = R.transpose() * v;               // velocity, target frame
    if (detail) detail->e = e;

    switch (s.kind) {
        case Kind::Free:
            return Vec3::Zero();

        case Kind::Impedance: {
            const Vec3 f_local = s.k.asDiagonal() * e - s.b.asDiagonal() * u;   // K e - B u
            return R * f_local;                                                 // back to the device frame
        }

        case Kind::Wall: {
            const double d = e.z();                         // penetration depth along the normal
            if (d <= 0.0) return Vec3::Zero();              // outside the wall: no force
            const double push = std::max(0.0, s.k.z() * d - s.b.z() * u.z());
            const Vec3 n = R.col(2);                        // outward normal = third column of R
            return push * n;
        }

        case Kind::Custom: {
            double vars[my::Expr::N_VARS] = {x.x(), x.y(), x.z(), v.x(), v.y(), v.z(), t,
                                             s.x_d.x(), s.x_d.y(), s.x_d.z(),
                                             s.k.x(), s.k.y(), s.k.z(), s.b.x(), s.b.y(), s.b.z()};
            return Vec3(s.fx.eval(vars), s.fy.eval(vars), s.fz.eval(vars));
        }
    }
    return Vec3::Zero();
}

}  // namespace haptics
