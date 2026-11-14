// Nintendo 3DS side of the MakeCode runtime: screen, buttons, touch, timing,
// logging and program start/exit.

#include <3ds.h>

#include "pxt.h"
#include "plat.h"
#include "input.h"
#include "hbldr.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <sys/stat.h>

// The default 3DS main-thread stack (32 KB) is far too small for game code.
u32 __stacksize__ = 1024 * 1024;

#define APP_DIR "sdmc:/3ds/makecode-player"

namespace music {
void shutdownSound();
void setSoundPaused(bool paused);
}

// How this program was started (kept for restarting it the same way).
static int startArgc;
static const char *const *startArgv;
// Set when the library app started this game: where the library is, so the
// game can go back to it. Passed as an argument "--library=sdmc:/...".
static const char *libraryPath;

// ---- logging -----------------------------------------------------------------

static FILE *logFile;

extern "C" void vdmesg(const char *format, va_list arg) {
    char buf[300];
    vsnprintf(buf, sizeof(buf), format, arg);
    printf("%s\n", buf);
    if (logFile) {
        fprintf(logFile, "[%8d] %s\n", pxt::current_time_ms(), buf);
        fflush(logFile);
    }
}

extern "C" void dmesg(const char *format, ...) {
    va_list arg;
    va_start(arg, format);
    vdmesg(format, arg);
    va_end(arg);
}

// ---- time --------------------------------------------------------------------

uint64_t plat_time_us() {
    return svcGetSystemTick() / CPU_TICKS_PER_USEC;
}

void plat_sleep_us(uint64_t us) {
    svcSleepThread(us * 1000ULL);
}

// ---- exit --------------------------------------------------------------------

void plat_exit() {
    settings_flush();
    plat_save_sync();
    music::shutdownSound();
    if (logFile)
        fclose(logFile);
    gfxExit();
    exit(0);
}

// Restarts the game by asking the Homebrew Launcher's loader to start this
// same .3dsx again as soon as we exit, instead of going back to its menu.
// (This is the same request the Homebrew Launcher makes to start a program.)
void plat_restart() {
    const char *self = startArgc > 0 ? startArgv[0] : NULL;
    if (hbldr_set_next(self, startArgc, startArgv))
        DMESG("Restarting game");
    else
        DMESG("Cannot restart from here; exiting");
    plat_exit();
}

// Leaves the game and goes back to the library app it was started from.
static void backToLibrary() {
    // "--from-game" tells the library not to show its start-up notice again.
    const char *args[] = {libraryPath, "--from-game"};
    if (!hbldr_set_next(libraryPath, 2, args))
        DMESG("Could not go back to the library");
    plat_exit();
}

static void printPlayerHeader() {
    consoleClear();
    printf("\x1b[3;1HMakeCode 3DS Player\n");
    printf("SELECT: menu\n\n");
}

// The in-game menu, opened with SELECT. The game is frozen while it is open
// (its clock too, so timers carry on where they left off).
static void pauseMenu() {
    enum { RESUME, RESTART, LIBRARY };
    const char *names[3];
    int actions[3], n = 0;
    names[n] = "Resume";
    actions[n++] = RESUME;
    names[n] = "Restart game";
    actions[n++] = RESTART;
    if (libraryPath) {
        names[n] = "Back to library";
        actions[n++] = LIBRARY;
    }

    uint64_t pausedAt = plat_time_us();
    music::setSoundPaused(true);
    int sel = 0, chosen = -1;
    bool redraw = true;
    while (chosen < 0) {
        if (!aptMainLoop())
            plat_exit();
        if (redraw) {
            consoleClear();
            printf("\x1b[3;3H== Paused ==");
            for (int i = 0; i < n; ++i)
                printf("\x1b[%d;3H%s %s", 6 + i * 2, i == sel ? ">" : " ", names[i]);
            printf("\x1b[28;2HA: choose   B: resume");
            // The text is drawn into cached memory: write it out to the
            // screen (the game's own frames normally do this).
            gfxFlushBuffers();
            gfxSwapBuffers();
            redraw = false;
        }
        gspWaitForVBlank();
        hidScanInput();
        u32 down = hidKeysDown();
        if (down & (KEY_DUP | KEY_CPAD_UP)) {
            sel = (sel + n - 1) % n;
            redraw = true;
        } else if (down & (KEY_DDOWN | KEY_CPAD_DOWN)) {
            sel = (sel + 1) % n;
            redraw = true;
        } else if (down & KEY_A) {
            chosen = actions[sel];
        } else if (down & (KEY_B | KEY_SELECT)) {
            chosen = RESUME;
        } else if (down & KEY_TOUCH) {
            // Console text rows are 8 pixels high; items sit on rows 6, 8, 10...
            touchPosition t;
            hidTouchRead(&t);
            int row = t.py / 8 + 1;
            for (int i = 0; i < n; ++i)
                if (row == 6 + i * 2)
                    chosen = actions[i];
        }
    }

    if (chosen == RESTART)
        plat_restart();
    if (chosen == LIBRARY)
        backToLibrary();

    // Resume: wait until every button is let go, so the press that closed
    // the menu does not reach the game.
    do {
        gspWaitForVBlank();
        hidScanInput();
    } while (hidKeysHeld() & ~(KEY_CPAD_UP | KEY_CPAD_DOWN | KEY_CPAD_LEFT | KEY_CPAD_RIGHT));
    pxt_time_paused(plat_time_us() - pausedAt);
    music::setSoundPaused(false);
    printPlayerHeader();
}

void plat_panic(int code) {
    printf("\x1b[31m\nThe game stopped: error %d\x1b[0m\n", code);
    printf("Press START to exit.\n");
    gfxFlushBuffers();
    gfxSwapBuffers();
    while (aptMainLoop()) {
        hidScanInput();
        if (hidKeysDown() & KEY_START)
            break;
        gspWaitForVBlank();
    }
    plat_exit();
}

// ---- input -------------------------------------------------------------------

namespace pxt {
void screenTouchToGame(int tx, int ty, int *gx, int *gy);
}

void plat_poll() {
    // Reading input more than a few hundred times a second is wasted work.
    static uint64_t lastPoll;
    auto now = plat_time_us();
    if (now - lastPoll < 4000)
        return;
    lastPoll = now;

    if (!aptMainLoop())
        plat_exit();

    // Write changed save data to the SD card, at most about once a second.
    static uint64_t lastFlush;
    if (settings_need_flush() && now - lastFlush > 1000000) {
        settings_flush();
        lastFlush = plat_time_us();
    }

    hidScanInput();
    u32 held = hidKeysHeld();

    // SELECT opens the in-game menu.
    if (hidKeysDown() & KEY_SELECT) {
        pauseMenu();
        hidScanInput();
        held = hidKeysHeld();
    }

    static const u32 hidMasks[BTN_COUNT] = {
        KEY_DUP | KEY_CPAD_UP, KEY_DDOWN | KEY_CPAD_DOWN, KEY_DLEFT | KEY_CPAD_LEFT, KEY_DRIGHT | KEY_CPAD_RIGHT,
        KEY_A, KEY_B, KEY_X, KEY_Y, KEY_L, KEY_R, KEY_ZL, KEY_ZR, KEY_START,
    };
    uint32_t buttons = 0;
    for (int i = 0; i < BTN_COUNT; ++i)
        if (held & hidMasks[i])
            buttons |= 1 << i;
    input_buttons(buttons);

    // The touch screen stands for the whole game screen, whatever its size.
    touchPosition t = {0, 0};
    if (held & KEY_TOUCH)
        hidTouchRead(&t);
    int gx, gy;
    pxt::screenTouchToGame(t.px, t.py, &gx, &gy);
    input_touch(held & KEY_TOUCH, gx, gy);
}

// ---- screen ------------------------------------------------------------------

namespace pxt {

static uint8_t palette[16][3]; // B, G, R: the order the 3DS framebuffer wants
static Image_ lastImg;
static bool screenReady;
static int frameCount;
static uint64_t fpsStart;

void setPalette(Buffer buf) {
    if (48 != buf->length)
        target_panic(PANIC_SCREEN_ERROR);
    for (int i = 0; i < 16; ++i) {
        palette[i][2] = buf->data[i * 3];
        palette[i][1] = buf->data[i * 3 + 1];
        palette[i][0] = buf->data[i * 3 + 2];
    }
}

// Size of the game picture on the top screen, worked out from the game's
// screen size (most games are 160x120; some set a bigger one):
//  - doubled if that fits (160x120 -> 320x240), which keeps pixels sharp;
//  - otherwise stretched or shrunk to fill the screen's height or width,
//    keeping its shape (320x240 comes out at exactly its own size).
static int gameW, gameH;   // the game's screen size
static int outW, outH;     // size it is drawn at
static int clearFrames;    // top-screen buffers still to be blacked out
static uint16_t rowMap[240]; // for each drawn row, which game row it shows

static void layoutScreen(int w, int h) {
    gameW = w;
    gameH = h;
    if (w * 2 <= 400 && h * 2 <= 240) {
        outW = w * 2;
        outH = h * 2;
    } else if (w * 240 <= h * 400) { // taller than the screen's shape: fit the height
        outH = 240;
        outW = w * 240 / h;
    } else {
        outW = 400;
        outH = h * 400 / w;
    }
    if (outW < 1)
        outW = 1;
    if (outH < 1)
        outH = 1;
    for (int y = 0; y < outH; ++y)
        rowMap[y] = y * h / outH;
    clearFrames = 2; // both the front and the back buffer
    DMESG("Game screen %dx%d, drawn at %dx%d", w, h, outW, outH);
}

// For the touch screen (320x240): which game pixel is under a touch.
void screenTouchToGame(int tx, int ty, int *gx, int *gy) {
    int w = gameW ? gameW : 160, h = gameH ? gameH : 120;
    *gx = tx * w / 320;
    *gy = ty * h / 240;
}

// Draws the game image centred on the top screen and waits for the screen
// refresh.
//
// The 3DS framebuffer is stored sideways: one column after another, each
// from the bottom of the screen to the top. MakeCode images are stored by
// column too, so the picture is built one column at a time.
void updateScreen(Image_ img) {
    if (!screenReady) {
        registerGC((TValue *)&lastImg);
        screenReady = true;
        DMESG("First frame drawn");
        fpsStart = plat_time_us();
    }
    if (img)
        lastImg = img;
    img = lastImg;
    if (!img)
        return;

    int w = img->width(), h = img->height();
    if (img->bpp() != 4 || w < 1 || h < 1)
        target_panic(PANIC_SCREEN_ERROR);
    if (w != gameW || h != gameH)
        layoutScreen(w, h);

    u16 fbW, fbH; // 240 x 400: the framebuffer is rotated
    u8 *fb = gfxGetFramebuffer(GFX_TOP, GFX_LEFT, &fbW, &fbH);
    if (clearFrames > 0) {
        memset(fb, 0, fbW * fbH * 3);
        clearFrames--;
    }
    int offX = (fbH - outW) / 2;
    int offY = (fbW - outH) / 2;
    int bh = img->byteHeight();
    const uint8_t *pix = img->pix();

    static uint8_t column[240 * 3];
    int lastSrcX = -1;
    for (int ox = 0; ox < outW; ++ox) {
        int sx = ox * w / outW;
        uint8_t *out = fb + (offX + ox) * fbW * 3 + offY * 3;
        if (sx != lastSrcX) {
            lastSrcX = sx;
            const uint8_t *src = pix + sx * bh;
            // Fill from the top of the picture, which is the end of the column.
            uint8_t *dst = column + outH * 3;
            for (int oy = 0; oy < outH; ++oy) {
                int y = rowMap[oy];
                const uint8_t *c = palette[(src[y >> 1] >> ((y & 1) ? 4 : 0)) & 0xf];
                dst -= 3;
                dst[0] = c[0];
                dst[1] = c[1];
                dst[2] = c[2];
            }
        }
        memcpy(out, column, outH * 3);
    }

    gfxFlushBuffers();
    gfxSwapBuffers();
    // Limit to the screen's 60 frames a second: wait for the next screen
    // refresh, unless one has already gone by while this frame was being
    // worked out. (Always waiting for the *next* refresh would turn a game
    // that needs 17 ms a frame into a 30 fps game instead of a 55 fps one.)
    gspWaitForEvent(GSPGPU_EVENT_VBlank0, false);

    // Frames-per-second readout on the bottom screen, once a second.
    frameCount++;
    auto now = plat_time_us();
    if (now - fpsStart >= 1000000) {
        printf("\x1b[1;1H%3d fps   ", (int)(frameCount * 1000000ULL / (now - fpsStart)));
        printf("\x1b[30;1H");
        frameCount = 0;
        fpsStart = now;
    }
}

} // namespace pxt

// ---- program entry ---------------------------------------------------------------

int main(int argc, char **argv) {
    // On a New 3DS / New 2DS, run the CPU at its full 804 MHz with the extra
    // cache enabled (programs get the old 268 MHz unless they ask). Does
    // nothing on the original models.
    osSetSpeedupEnable(true);

    gfxInitDefault();
    consoleInit(GFX_BOTTOM, NULL);

    mkdir("sdmc:/3ds", 0777);
    mkdir(APP_DIR, 0777);
    mkdir(APP_DIR "/saves", 0777);
    logFile = fopen(APP_DIR "/log.txt", "w");

    static char *fakeArgv[] = {(char *)"makecode", NULL};
    pxt::initialArgv = argc > 0 ? argv : fakeArgv;
    startArgc = argc;
    startArgv = argv;
    for (int i = 1; i < argc; ++i)
        if (!strncmp(argv[i], "--library=", 10))
            libraryPath = argv[i] + 10;

    // Black out both copies of the top screen once; the game image only
    // covers the middle of it.
    for (int i = 0; i < 2; ++i) {
        u16 fbW, fbH;
        u8 *fb = gfxGetFramebuffer(GFX_TOP, GFX_LEFT, &fbW, &fbH);
        memset(fb, 0, fbW * fbH * 3);
        gfxFlushBuffers();
        gfxSwapBuffers();
        gspWaitForVBlank();
    }

    input_init();

    printPlayerHeader();
    if (libraryPath)
        DMESG("Started from the library (%s)", libraryPath);

    pxt::startGame();
    return 0;
}
