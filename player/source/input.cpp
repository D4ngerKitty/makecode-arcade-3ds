// Turns 3DS button and touch changes into MakeCode events.

#include "pxt.h"
#include "input.h"

#include <stdlib.h>
#include <string.h>

// Arcade controller buttons (game/controller.ts)
#define INTERNAL_KEY_UP 2050
#define INTERNAL_KEY_DOWN 2051
enum ArcadeKey { K_LEFT = 1, K_UP, K_RIGHT, K_DOWN, K_A, K_B, K_MENU };

// browser-events extension (keyboard and mouse)
#define BE_POINTER_MOVE 6859
#define BE_INTERNAL_POINTER_DOWN 6868
#define BE_INTERNAL_POINTER_UP 6869
#define BE_INTERNAL_KEY_DOWN 6870
#define BE_INTERNAL_KEY_UP 6871

// Per-game bindings, as "BUTTON=n,n;BUTTON=n". The build tool generates this
// from the game's controls.json; empty means defaults. Each n is one thing the
// button does: a positive number is a keyboard key (browser-events key code),
// a negative number is an Arcade button (-5 is A, see ArcadeKey).
extern "C" __attribute__((weak)) const char *pxt3ds_controls = "";

#define MAX_ACTIONS 4

// What one 3DS button does: up to four actions, zero-terminated unless full.
struct ButtonMap {
    const char *name;
    int actions[MAX_ACTIONS];
};

// Defaults: directions are the Arcade directions and the arrow keys, A and B
// are Arcade A and B (and Space / Enter), START opens the MakeCode menu.
static ButtonMap buttonMap[BTN_COUNT] = {
    {"UP", {-K_UP, 38}},     {"DOWN", {-K_DOWN, 40}}, {"LEFT", {-K_LEFT, 37}}, {"RIGHT", {-K_RIGHT, 39}},
    {"A", {-K_A, 32}},       {"B", {-K_B, 13}},       {"X", {0}},              {"Y", {0}},
    {"L", {0}},              {"R", {0}},              {"ZL", {0}},             {"ZR", {0}},
    {"START", {-K_MENU}},
};

static uint32_t heldButtons;
static uint32_t arcadeState; // bit n set = Arcade button n is held
static bool touching;
static int mouseXPos = -1, mouseYPos = -1;

int input_button_by_name(const char *name, int len) {
    for (int i = 0; i < BTN_COUNT; ++i)
        if ((int)strlen(buttonMap[i].name) == len && !strncmp(buttonMap[i].name, name, len))
            return i;
    return -1;
}

// A button named in pxt3ds_controls does exactly what is listed there (which
// may be nothing); buttons not named keep their defaults.
void input_init() {
    const char *p = pxt3ds_controls;
    while (*p) {
        const char *eq = strchr(p, '=');
        if (!eq)
            break;
        int idx = input_button_by_name(p, eq - p);
        ButtonMap *b = idx < 0 ? NULL : &buttonMap[idx];
        p = eq + 1;
        int n = 0;
        if (b)
            memset(b->actions, 0, sizeof(b->actions));
        while (*p && *p != ';') {
            char *end;
            int code = strtol(p, &end, 10);
            if (end == p)
                break;
            p = end;
            if (b && n < MAX_ACTIONS && code)
                b->actions[n++] = code;
            if (*p == ',')
                p++;
        }
        while (*p && *p != ';')
            p++;
        if (*p == ';')
            p++;
    }
}

// Is this action produced by any button in `held`?
static bool actionHeld(uint32_t held, int action) {
    for (int i = 0; i < BTN_COUNT; ++i)
        if (held & (1 << i))
            for (int k = 0; k < MAX_ACTIONS && buttonMap[i].actions[k]; ++k)
                if (buttonMap[i].actions[k] == action)
                    return true;
    return false;
}

void input_buttons(uint32_t held) {
    uint32_t before = heldButtons;
    uint32_t changed = held ^ before;
    if (!changed)
        return;
    heldButtons = held;

    for (int i = 0; i < BTN_COUNT; ++i) {
        if (!(changed & (1 << i)))
            continue;
        bool isDown = (held >> i) & 1;
        for (int k = 0; k < MAX_ACTIONS && buttonMap[i].actions[k]; ++k) {
            int action = buttonMap[i].actions[k];
            // Two buttons can do the same thing: it only counts as pressed
            // when the first goes down, and released when the last comes up.
            if (isDown ? actionHeld(before, action) : actionHeld(held, action))
                continue;
            if (action < 0) {
                int key = -action;
                if (isDown)
                    arcadeState |= 1 << key;
                else
                    arcadeState &= ~(1 << key);
                int ev = isDown ? INTERNAL_KEY_DOWN : INTERNAL_KEY_UP;
                pxt::raiseEvent(ev, key);
                pxt::raiseEvent(ev, 0); // "any button"
            } else {
                pxt::raiseEvent(isDown ? BE_INTERNAL_KEY_DOWN : BE_INTERNAL_KEY_UP, action);
            }
        }
        // Later buttons in this same update must see this one's new state.
        before = (before & ~(1 << i)) | (held & (1 << i));
    }
}

// The touch screen acts as the mouse.
void input_touch(bool nowTouching, int x, int y) {
    if (nowTouching) {
        bool moved = x != mouseXPos || y != mouseYPos;
        mouseXPos = x;
        mouseYPos = y;
        if (!touching)
            pxt::raiseEvent(BE_INTERNAL_POINTER_DOWN, 1);
        else if (moved)
            pxt::raiseEvent(BE_POINTER_MOVE, 0);
    } else if (touching) {
        pxt::raiseEvent(BE_INTERNAL_POINTER_UP, 1);
    }
    touching = nowTouching;
}

namespace pxt {
int pressureLevelByButtonId(int btnId, int codalId) {
    return (arcadeState & (1 << btnId)) ? 512 : 0;
}
} // namespace pxt

namespace browserEvents {
int mouseX() {
    return mouseXPos;
}
int mouseY() {
    return mouseYPos;
}
} // namespace browserEvents
