#pragma once
#include <cstdint>

// Mouse capture is independent of cursor visibility and may remain active in
// a game menu. A hidden/suppressed cursor or a tiny camera lock blocks input.
inline bool cursorReleased(bool handle, bool showing, bool suppressed, long width, long height) {
 return handle && showing && !suppressed && width > 4 && height > 4;
}
// A transient visible cursor is not enough to release game input. Require a
// stable visible cursor on the same foreground window. Blocking
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
