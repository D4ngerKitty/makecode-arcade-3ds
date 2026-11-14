// What the runtime needs from the machine it runs on. Implemented for the
// 3DS in plat3ds.cpp.
#ifndef __PLAT_H
#define __PLAT_H

#include <stdint.h>

// Microseconds since some fixed point; never goes backwards.
uint64_t plat_time_us();

// Sleeps the whole program for up to `us` microseconds.
void plat_sleep_us(uint64_t us);

// Called often (every time fibers are scheduled). Reads buttons and the touch
// screen, raises input events, and handles the HOME button / lid.
void plat_poll();

// Shows a fatal error and exits. Does not return.
void plat_panic(int code);

// Leaves the program cleanly. Does not return.
void plat_exit();

// Starts the game again from the beginning. Does not return.
void plat_restart();

// Tells the game's clock that it was frozen for this long (pause menu).
void pxt_time_paused(uint64_t us);

// ---- game saves (see settings.cpp) -------------------------------------------

// Reads every saved value of this game, calling add() for each.
void plat_save_load(const char *game, void (*add)(const char *key, const uint8_t *data, int length));
// Stores this game's whole save (see settings.cpp for the layout). Takes
// ownership of data (allocated with malloc) and may write it later, in the
// background.
void plat_save_store(const char *game, uint8_t *data, int length);
// Waits until everything handed to plat_save_store is safely written.
void plat_save_sync();

// Writes changed save data to storage; cheap when nothing changed.
void settings_flush();
bool settings_need_flush();
bool settings_parse(const uint8_t *blob, int size, void (*add)(const char *key, const uint8_t *data, int length));

namespace pxt {
// Runs the compiled game linked into this program. Does not return.
void startGame();
} // namespace pxt

#endif
