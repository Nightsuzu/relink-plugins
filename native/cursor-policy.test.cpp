#include "cursor-policy.h"
#include <cassert>
int main() {
 CursorReleaseGate gate;
 assert(!gate.update(false,1,0));
 assert(!gate.update(true,1,10));
 assert(!gate.update(true,1,199));
 assert(!gate.update(false,1,200)); // brief cursor flash never enables input
 assert(!gate.update(true,1,300));
 assert(!gate.update(true,1,499));
 assert(gate.update(true,1,500)); // stable release
 assert(!gate.update(false,1,501)); // re-capture blocks immediately
 assert(!gate.update(true,1,600));
 assert(!gate.update(true,2,800)); // switching windows requires fresh evidence
 assert(gate.update(true,2,1000));
 assert(!gate.update(true,0,1001)); // unavailable foreground fails closed
 assert(!gate.update(true,2,1100));
 assert(!gate.update(true,2,1099)); // never accept an invalid time interval
 return 0;
}
