// PC test harness: runs the same runtime and the same compiled game under
// QEMU (an ARM emulator), with no screen or sound hardware. Time is simulated,
// frames are saved as image files, and button presses come from a script.
//
// tools/test-qemu.js writes the settings to harness.txt, one per line, e.g.
//   frames=600
//   shots=60,300
//   input=120:A:1,130:A:0
// (input entries are frame:BUTTON:1 for press, :0 for release)

#include "pxt.h"
#include "plat.h"
#include "input.h"
#include "SoundOutput.h"
#include "melody.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <errno.h>

// ---- memory ------------------------------------------------------------------
// Put the heap where the 3DS has it (at 0x08000000), because the runtime
// tells built-in objects from heap objects by address.

// devkitARM's C library takes its heap from these two variables.
extern "C" char *fake_heap_start;
extern "C" char *fake_heap_end;

// ---- talking to the PC -------------------------------------------------------
// QEMU "semihosting": the program asks the emulator to print text, write
// files and stop. (devkitARM's C library cannot do this by itself.)

static int semihost(int op, void *arg) {
    register int r0 asm("r0") = op;
    register void *r1 asm("r1") = arg;
    asm volatile("svc 0x123456" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

static void out(const char *format, ...) {
    char buf[400];
    va_list arg;
    va_start(arg, format);
    vsnprintf(buf, sizeof(buf), format, arg);
    va_end(arg);
    semihost(0x04, buf); // SYS_WRITE0
}

static void stopEmulator() {
    semihost(0x18, (void *)0x20026); // SYS_EXIT, "application exit"
    for (;;) {
    }
}

static int hostOpenForWrite(const char *name) {
    uint32_t args[3] = {(uint32_t)name, 5 /* "wb" */, (uint32_t)strlen(name)};
    return semihost(0x01, args); // SYS_OPEN
}

static void hostWrite(int fd, const void *data, int len) {
    uint32_t args[3] = {(uint32_t)fd, (uint32_t)data, (uint32_t)len};
    semihost(0x05, args); // SYS_WRITE
}

// Reads a whole (small) text file from the PC into buf; returns its length.
static int hostReadFile(const char *name, char *buf, int max) {
    uint32_t open[3] = {(uint32_t)name, 0 /* "r" */, (uint32_t)strlen(name)};
    int fd = semihost(0x01, open);
    if (fd < 0)
        return 0;
    uint32_t args[3] = {(uint32_t)fd, (uint32_t)buf, (uint32_t)(max - 1)};
    int notRead = semihost(0x06, args); // SYS_READ returns bytes NOT read
    int len = max - 1 - notRead;
    uint32_t close[1] = {(uint32_t)fd};
    semihost(0x02, close);
    buf[len < 0 ? 0 : len] = 0;
    return len < 0 ? 0 : len;
}

static void hostClose(int fd) {
    uint32_t args[1] = {(uint32_t)fd};
    semihost(0x02, args); // SYS_CLOSE
}

#include "profile.inc"

// ---- logging -----------------------------------------------------------------

extern "C" void vdmesg(const char *format, va_list arg) {
    char buf[300];
    vsnprintf(buf, sizeof(buf), format, arg);
    out("[%7d] %s\n", pxt::current_time_ms(), buf);
}

extern "C" void dmesg(const char *format, ...) {
    va_list arg;
    va_start(arg, format);
    vdmesg(format, arg);
    va_end(arg);
}

// ---- simulated time ------------------------------------------------------------

static uint64_t virtualTime = 1000000;

uint64_t plat_time_us() {
    return virtualTime += 5; // every look at the clock costs a little time
}

void plat_sleep_us(uint64_t us) {
    virtualTime += us;
}

// ---- exit --------------------------------------------------------------------

// The harness keeps saves in memory only.
void plat_save_load(const char *, void (*)(const char *, const uint8_t *, int)) {}
void plat_save_store(const char *game, uint8_t *data, int length) {
    out("save stored (%d bytes)\n", length);
    free(data);
}
void plat_save_sync() {}

void plat_restart() {
    out("RESTART requested\n");
    stopEmulator();
}

void plat_exit() {
    out("EXIT\n");
    stopEmulator();
}

void plat_panic(int code) {
    out("PANIC %d\n", code);
    stopEmulator();
}

// ---- scripted input ------------------------------------------------------------

static int frameNo;
static int maxFrames = 300;
static int shots[64], numShots;
static struct { int frame, button, down; } script[1024];
static int numScript, scriptPos;
static uint32_t held;

void plat_poll() {
    while (scriptPos < numScript && script[scriptPos].frame <= frameNo) {
        auto &s = script[scriptPos++];
        if (s.down)
            held |= 1 << s.button;
        else
            held &= ~(1 << s.button);
    }
    input_buttons(held);
}

// ---- sound: produce samples and throw them away ---------------------------------

namespace pxt {
void target_disable_irq() {}
void target_enable_irq() {}
} // namespace pxt

namespace music {
static WSynthesizer *synth;
N3dsDAC::N3dsDAC(WSynthesizer &data) : src(data) {
    synth = &data;
}
} // namespace music

// ---- screen ------------------------------------------------------------------

namespace pxt {

static uint8_t palette[16][3];
static Image_ lastImg;
static bool screenReady;

void setPalette(Buffer buf) {
    if (48 != buf->length)
        target_panic(PANIC_SCREEN_ERROR);
    memcpy(palette, buf->data, 48);
}

static void saveFrame(Image_ img) {
    char name[40];
    snprintf(name, sizeof(name), "frame_%05d.ppm", frameNo);
    int f = hostOpenForWrite(name);
    if (f < 0)
        return;
    int w = img->width(), h = img->height(), bh = img->byteHeight();
    char header[40];
    snprintf(header, sizeof(header), "P6\n%d %d\n255\n", w, h);
    hostWrite(f, header, strlen(header));
    static uint8_t row[400 * 3];
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            int c = (img->pix()[x * bh + (y >> 1)] >> ((y & 1) ? 4 : 0)) & 0xf;
            memcpy(row + x * 3, palette[c], 3);
        }
        hostWrite(f, row, w * 3);
    }
    hostClose(f);
}

void updateScreen(Image_ img) {
    if (!screenReady) {
        registerGC((TValue *)&lastImg);
        screenReady = true;
        DMESG("First frame drawn");
    }
    if (img)
        lastImg = img;
    img = lastImg;
    if (!img)
        return;
    if (img->bpp() != 4)
        target_panic(PANIC_SCREEN_ERROR);

    frameNo++;
    for (int i = 0; i < numShots; ++i)
        if (shots[i] == frameNo)
            saveFrame(img);

    // One frame's worth of sound, as the 3DS sound thread would ask for.
    if (music::synth) {
        static int16_t samples[546];
        music::synth->fillSamples(samples, 546);
    }

    if (frameNo % 60 == 0)
        settings_flush();
    if (frameNo == profStartFrame)
        profStart();
    if (frameNo % 100 == 0) {
        static uint32_t lastCount;
        uint32_t now = profKiloInstructions();
        DMESG("frame %d  (%d thousand instructions per frame)", frameNo, (int)((now - lastCount) / 100));
        lastCount = now;
    }
    if (frameNo >= maxFrames) {
        profSave();
        saveFrame(img);
        plat_exit();
    }
    virtualTime += 16667; // the screen refresh
}

} // namespace pxt

// ---- program entry ---------------------------------------------------------------

static void parseArg(char *arg);

static void parseArg(char *arg) {
    if (!strncmp(arg, "frames=", 7)) {
        maxFrames = atoi(arg + 7);
    } else if (!strncmp(arg, "profile=", 8)) {
        profStartFrame = atoi(arg + 8);
    } else if (!strncmp(arg, "shots=", 6)) {
        for (char *p = strtok(arg + 6, ","); p && numShots < 64; p = strtok(NULL, ","))
            shots[numShots++] = atoi(p);
    } else if (!strncmp(arg, "input=", 6)) {
        for (char *p = strtok(arg + 6, ","); p && numScript < 1024; p = strtok(NULL, ",")) {
            int frame = atoi(p);
            char *name = strchr(p, ':');
            if (!name)
                continue;
            name++;
            char *state = strchr(name, ':');
            if (!state)
                continue;
            int b = input_button_by_name(name, state - name);
            if (b < 0) {
                out("unknown button in input script: %s\n", name);
                continue;
            }
            script[numScript].frame = frame;
            script[numScript].button = b;
            script[numScript].down = atoi(state + 1);
            numScript++;
        }
    }
}

int main(int argc, char **argv) {
    fake_heap_start = (char *)0x08000000;
    fake_heap_end = (char *)0x0e000000;
    // Settings come from harness.txt (written by tools/test-qemu.js), one per
    // line: the emulated machine's command line is too short for long scripts.
    static char settings[16384];
    hostReadFile("harness.txt", settings, sizeof(settings));
    char *lines[16];
    int numLines = 0;
    for (char *l = strtok(settings, "\r\n"); l && numLines < 16; l = strtok(NULL, "\r\n"))
        lines[numLines++] = l;
    for (int i = 0; i < numLines; ++i)
        parseArg(lines[i]);
    static char *fakeArgv[] = {(char *)"makecode", NULL};
    pxt::initialArgv = fakeArgv;
    input_init();
    profInit();
    pxt::startGame();
    return 0;
}
