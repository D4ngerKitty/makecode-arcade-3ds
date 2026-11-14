// Small runtime services that are the same on every machine the runtime
// runs on (the 3DS, and the PC test harness).

#include "pxt.h"
#include "plat.h"

namespace pxt {

void target_exit() {
    plat_exit();
}

// Called when a game restarts itself (game over, game.reset()).
extern "C" void target_reset() {
    plat_restart();
}

extern "C" void target_init() {
    seedRandom((int)plat_time_us() ^ 0xC0DA1);
}

void sendSerial(const char *data, int len) {}

void dumpDmesg() {}

uint64_t getLongSerialNumber() {
    return 0x3d5a0042f00d0042ULL;
}

const char *getConfigString(const char *name) {
    return NULL;
}

int getConfigInt(const char *name, int defl) {
    return defl;
}

int setScreenBrightnessSupported() {
    return 0;
}

void setScreenBrightness(int level) {}

void updateStats(String msg) {}

void setupButton(int buttonId, int key) {}

} // namespace pxt

namespace control {

void raiseEvent(int src, int value) {
    pxt::raiseEvent(src, value);
}

int allocateNotifyEvent() {
    return pxt::allocateNotifyEvent();
}

String deviceDalVersion() {
    return mkString("3ds");
}

void dmesg(String s) {
    DMESG("# %s", s->getUTF8Data());
}

uint32_t _ramSize() {
    return 16 * 1024 * 1024;
}

bool isUSBInitialized() {
    return false;
}

} // namespace control

// The runtime only has this as an empty inline, but games refer to it by
// name, so it needs a real (empty) definition.
extern "C" void pxt_pxt__dumpPerfCounters() {}
