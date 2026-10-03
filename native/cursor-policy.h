#pragma once
#include <cstdint>

// A transient visible cursor is not enough to release game input. Require a
// stable visible, uncaptured cursor on the same foreground window. Blocking
// is immediate; only enabling interaction is delayed.
struct CursorReleaseGate {
 bool pending = false;
 std::uintptr_t window = 0;
 std::uint64_t since = 0;
 bool update(bool released, std::uintptr_t foreground, std::uint64_t now) {
  if (!released || !foreground) { pending = false; window = 0; return false; }
  if (!pending || foreground != window) {
   pending = true; window = foreground; since = now; return false;
  }
  return now >= since && now - since >= 200;
 }
};
