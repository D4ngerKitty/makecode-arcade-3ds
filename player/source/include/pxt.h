// Main runtime header for the 3DS port (takes the place of the Linux one).
#ifndef __PXT_H
#define __PXT_H

#include "pxtbase.h"

#define DEVICE_EVT_ANY 0
#define DEVICE_ID_NOTIFY_ONE 1022
#define DEVICE_ID_NOTIFY 1023

namespace pxt {
void raiseEvent(int id, int event);
int allocateNotifyEvent();
void sleep_core_us(uint64_t us);
void startUser();
void stopUser();
int tryLockUser();

void target_disable_irq();
void target_enable_irq();

const char *getConfigString(const char *name);
int getConfigInt(const char *name, int defl);

extern "C" void target_init();

extern volatile bool paniced;
extern char **initialArgv;
void target_exit();

// Buffer, Sound, and Image share representation.
typedef Buffer Sound;
} // namespace pxt

#endif
