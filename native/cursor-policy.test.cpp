#include "cursor-policy.h"
#include <cassert>
int main() {
 assert(cursorReleased(true,true,false,1920,1080)); // full-window confinement is a usable cursor
 assert(cursorReleased(true,true,false,800,600)); // menu capture does not enter this visibility policy
 assert(!cursorReleased(true,false,false,1920,1080));
 assert(!cursorReleased(true,true,true,1920,1080));
 assert(!cursorReleased(false,true,false,1920,1080));
 assert(!cursorReleased(true,true,false,1,1)); // camera lock
 assert(!cursorReleased(true,true,false,4,1080));
 assert(!cursorReleased(true,true,false,1920,4));
 CursorReleaseGate gate;
 assert(!gate.update(false,1,0));
 assert(!gate.update(true,1,10));
 assert(!gate.update(true,1,199));
 assert(!gate.update(false,1,200)); // brief cursor flash never enables input
 assert(!gate.update(true,1,300));
 assert(!gate.update(true,1,499));
 assert(gate.update(true,1,500)); // stable release
 assert(!gate.update(false,1,501)); // hidden/locked cursor blocks immediately
 assert(!gate.update(true,1,600));
 assert(!gate.update(true,2,800)); // switching windows requires fresh evidence
 assert(gate.update(true,2,1000));
 assert(!gate.update(true,0,1001)); // unavailable foreground fails closed
 assert(!gate.update(true,2,1100));
 assert(!gate.update(true,2,1099)); // never accept an invalid time interval
 return 0;
}
