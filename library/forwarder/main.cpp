// The HOME-menu title for "Makecode Arcade on 3ds" (.cia).
//
// Games and the library are .3dsx homebrew, which Luma3DS runs by loading
// them into one "host" title (Download Play, unless changed in the Rosalina
// menu) in place of that title's own program. This tiny program points the
// loader at the library and then starts the host title, so picking the icon
// on the HOME menu opens the library. From there, games and the library
// start each other the same way as when run from the Homebrew Launcher.

#include <3ds.h>
#include <stdio.h>
#include <sys/stat.h>

#include "hbldr.h"

#define LIBRARY "sdmc:/3ds/makecode-arcade/library.3dsx"

// Luma3DS's shared settings (readable by every program): which title hosts
// .3dsx programs, and whether that is switched on.
struct LumaSharedConfig {
    u64 hbldr_3dsx_tid;
    u64 selected_hbldr_3dsx_tid;
    bool use_hbldr;
};
#define LUMA_CONFIG ((volatile LumaSharedConfig *)(OS_SHAREDCFG_VADDR + 0x800))

static void fail(const char *message) {
    gfxInitDefault();
    consoleInit(GFX_TOP, NULL);
    printf("\x1b[2;2HMakecode Arcade on 3ds\n\n");
    printf("  %s\n\n  Press START to go back.", message);
    while (aptMainLoop()) {
        hidScanInput();
        if (hidKeysDown() & KEY_START)
            break;
        gspWaitForVBlank();
    }
    gfxExit();
}

int main() {
    struct stat st;
    if (stat(LIBRARY, &st) != 0) {
        fail("The library is not on the SD card.\n\n"
             "  Copy the makecode-arcade folder\n"
             "  into the 3ds folder on the SD card.");
        return 0;
    }

    u64 host = LUMA_CONFIG->hbldr_3dsx_tid;
    if (!LUMA_CONFIG->use_hbldr || host == 0) {
        fail("This needs Luma3DS custom firmware\n  (with its homebrew loader on).");
        return 0;
    }

    const char *args[] = {LIBRARY};
    if (!hbldr_set_next(LIBRARY, 1, args)) {
        fail("Could not reach the homebrew loader.");
        return 0;
    }

    // System titles (like Download Play) live on the system memory; games on SD.
    FS_MediaType media = (host >> 32) == 0x00040000 ? MEDIATYPE_SD : MEDIATYPE_NAND;
    aptSetChainloader(host, media);
    return 0;
}
