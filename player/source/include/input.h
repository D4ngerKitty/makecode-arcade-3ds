// Button and touch handling shared by the 3DS and the PC test harness.
// The machine-specific code reports which 3DS buttons are held; this turns
// changes into the events MakeCode games listen for.
#ifndef __INPUT_H
#define __INPUT_H

#include <stdint.h>

enum Button3ds {
    BTN_UP, // D-pad or Circle Pad
    BTN_DOWN,
    BTN_LEFT,
    BTN_RIGHT,
    BTN_A,
    BTN_B,
    BTN_X,
    BTN_Y,
    BTN_L,
    BTN_R,
    BTN_ZL,
    BTN_ZR,
    BTN_START,
    BTN_COUNT
};

// Reads the per-game control mapping. Call once at start-up.
void input_init();

// Call with the set of buttons currently held (bit n = Button3ds n).
void input_buttons(uint32_t held);

// Call with the touch state; x,y are in game pixels (0..159, 0..119).
void input_touch(bool touching, int x, int y);

// Returns the Button3ds with this name ("A", "START", ...), or -1.
int input_button_by_name(const char *name, int len);

#endif
