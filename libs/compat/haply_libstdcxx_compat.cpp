// haply_libstdcxx_compat.cpp - lets Haply's HardwareAPI link on older Linux (e.g. Raspberry Pi OS 11 Bullseye).
//
// Haply's "linux.gcc10.aarch64" archive (HardwareAPI 0.2.8) was in fact compiled with Debian 12's GCC 12.2,
// so it references four runtime symbols that glibc 2.31 / libstdc++ 10 (Debian 11) do not provide:
//
//   __libc_single_threaded                                  glibc >= 2.32
//   std::__exception_ptr::exception_ptr::_M_addref()        exported by libstdc++ >= 12 (GCC 12)
//   std::__exception_ptr::exception_ptr::_M_release()       exported by libstdc++ >= 12 (GCC 12)
//   std::__atomic_futex_unsigned_base::_M_futex_wait_until_steady(...)   libstdc++ >= 11 (GCC 11)
//
// Each definition below is compiled only when the system really lacks it, and each one reuses what the
// older runtime already exports, so behaviour matches the newer runtime. On Windows, on newer Linux, or
// with another HardwareAPI build, this file compiles to nothing.

#if defined(__linux__)
// Include first: these define __GLIBC__ / __GLIBC_MINOR__ (glibc) and _GLIBCXX_RELEASE (libstdc++).
#include <cerrno>
#include <ctime>
#include <exception>
#include <new>

#include <linux/futex.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif

#if defined(__linux__) && defined(__GLIBC__)

// ---- glibc < 2.32: "is the process single-threaded?" flag read by GCC 12's inline atomics. --------------
// 0 means "assume multi-threaded": libstdc++ then always uses real atomic operations, which is always correct.
#if (__GLIBC__ == 2) && (__GLIBC_MINOR__ < 32)
extern "C" {
char __libc_single_threaded = 0;
}
#endif

#if defined(_GLIBCXX_RELEASE) && (_GLIBCXX_RELEASE <= 10)

// ---- libstdc++ < 12: exception_ptr reference counting. -----------------------------------------------------
// GCC 12 inlines exception_ptr's copy/destroy and calls these two members directly. In GCC 10 they exist only
// inside libstdc++.so (not exported), but its exported copy-constructor and destructor do exactly this work.
namespace std {
namespace __exception_ptr {

void exception_ptr::_M_addref() noexcept {
    if (_M_exception_object) {
        // The exported copy-constructor adds one reference. The copy is a bare pointer and is never destroyed,
        // so the net effect is exactly +1 on the exception's reference count.
        alignas(exception_ptr) unsigned char raw[sizeof(exception_ptr)];
        ::new (static_cast<void*>(raw)) exception_ptr(*this);
    }
}

void exception_ptr::_M_release() noexcept {
    if (_M_exception_object) {
        // The exported destructor drops one reference and frees the exception when it reaches zero
        // (and then clears _M_exception_object), which is what GCC 12's _M_release() does.
        this->~exception_ptr();
    }
}

}  // namespace __exception_ptr
}  // namespace std

#endif  // _GLIBCXX_RELEASE <= 10

#if defined(_GLIBCXX_RELEASE) && (_GLIBCXX_RELEASE <= 10) && defined(__LP64__)

// ---- libstdc++ < 11: futex wait with a steady-clock (CLOCK_MONOTONIC) deadline, used by std::future. ------
// Same algorithm as GCC 11's src/c++11/futex.cc. The function is a static member whose two std::chrono
// arguments are single-`long` structs, passed exactly like `long` on LP64 targets, so it is defined here
// under its mangled name (GCC 10's header does not declare it).
extern "C" bool myhaply_futex_wait_until_steady(unsigned* addr, unsigned val, bool has_timeout, long s, long ns)
    __asm__("_ZNSt28__atomic_futex_unsigned_base26_M_futex_wait_until_steadyEPjjbNSt6chrono8durationIlSt5ratioILl1ELl1EEEENS2_IlS3_ILl1ELl1000000000EEEE");

extern "C" bool myhaply_futex_wait_until_steady(unsigned* addr, unsigned val, bool has_timeout, long s, long ns) {
    if (!has_timeout) {
        // Spurious wake-ups are fine: the caller re-checks the value and waits again.
        syscall(SYS_futex, addr, FUTEX_WAIT, val, nullptr);
        return true;
    }
    if (s < 0) return false;  // deadline already passed
    struct timespec rt;
    rt.tv_sec = s;
    rt.tv_nsec = ns;
    // FUTEX_WAIT_BITSET takes an absolute deadline on CLOCK_MONOTONIC (no FUTEX_CLOCK_REALTIME flag).
    if (syscall(SYS_futex, addr, FUTEX_WAIT_BITSET, val, &rt, nullptr, FUTEX_BITSET_MATCH_ANY) == -1) {
        if (errno == ETIMEDOUT) return false;
    }
    return true;
}

#endif  // _GLIBCXX_RELEASE <= 10

#endif  // __linux__ && __GLIBC__
