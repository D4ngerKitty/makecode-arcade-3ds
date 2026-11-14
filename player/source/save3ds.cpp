// Game saves on the 3DS SD card.
//
// Each game's save is one file, sdmc:/3ds/makecode-player/saves/<game>/save.bin,
// written by a background thread so the game never waits for the SD card.
// It is written under a temporary name first and then renamed, so a crash or
// power cut in the middle leaves the previous save intact.
//
// Earlier builds kept one small file per saved value in the same folder;
// those are still read when there is no save.bin yet.

#include <3ds.h>

#include "pxt.h"
#include "plat.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <sys/stat.h>

// Lowercase letters and digits stay; capitals become "-x"; anything else "_hh".
// (The same naming MakeCode's own file-based saves use.)
static void encodeName(const char *str, char *out, int max) {
    static const char *hexD = "0123456789abcdef";
    int dp = 0;
    for (auto sp = str; *sp && dp < max - 4; ++sp) {
        unsigned char c = *sp;
        if (('0' <= c && c <= '9') || ('a' <= c && c <= 'z')) {
            out[dp++] = c;
        } else if ('A' <= c && c <= 'Z') {
            out[dp++] = '-';
            out[dp++] = c | 0x20;
        } else {
            out[dp++] = '_';
            out[dp++] = hexD[c >> 4];
            out[dp++] = hexD[c & 0xf];
        }
    }
    out[dp] = 0;
}

static int hexVal(char c) {
    if ('0' <= c && c <= '9')
        return c - '0';
    c |= 0x20;
    if ('a' <= c && c <= 'f')
        return c - 'a' + 10;
    return -1;
}

static void decodeName(const char *str, char *out, int max) {
    int dp = 0;
    for (auto sp = str; *sp && dp < max - 1; ++sp) {
        char c = *sp;
        if (('0' <= c && c <= '9') || ('a' <= c && c <= 'z'))
            out[dp++] = c;
        else if (c == '-' && sp[1]) {
            out[dp++] = sp[1] & ~0x20;
            sp++;
        } else if (c == '_' && hexVal(sp[1]) >= 0 && hexVal(sp[2]) >= 0) {
            out[dp++] = (hexVal(sp[1]) << 4) | hexVal(sp[2]);
            sp += 2;
        }
    }
    out[dp] = 0;
}

static void gameDir(const char *game, char *out, int max) {
    char enc[400];
    encodeName(game, enc, sizeof(enc));
    snprintf(out, max, "%s/%s", SETTINGSDIR, enc);
}

static uint8_t *readFile(const char *path, long *size) {
    FILE *f = fopen(path, "rb");
    if (!f)
        return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    auto data = (uint8_t *)malloc(sz + 1);
    bool ok = fread(data, 1, sz, f) == (size_t)sz;
    fclose(f);
    if (!ok) {
        free(data);
        return NULL;
    }
    *size = sz;
    return data;
}

void plat_save_load(const char *game, void (*add)(const char *key, const uint8_t *data, int length)) {
    char dir[500], path[1200];
    gameDir(game, dir, sizeof(dir));
    mkdir(dir, 0777);

    long size;
    snprintf(path, sizeof(path), "%s/save.bin", dir);
    auto blob = readFile(path, &size);
    if (blob) {
        bool ok = settings_parse(blob, size, add);
        free(blob);
        DMESG(ok ? "Save loaded" : "Save file is damaged; part of it may be missing");
        return;
    }

    // No save.bin: read the one-file-per-value layout of earlier builds.
    auto dp = opendir(dir);
    if (!dp)
        return;
    int count = 0;
    for (;;) {
        dirent *ep = readdir(dp);
        if (!ep)
            break;
        if (ep->d_name[0] == '.' || !strncmp(ep->d_name, "save.", 5))
            continue;
        char key[600];
        snprintf(path, sizeof(path), "%s/%s", dir, ep->d_name);
        decodeName(ep->d_name, key, sizeof(key));
        auto data = readFile(path, &size);
        if (data) {
            add(key, data, size);
            free(data);
            count++;
        }
    }
    closedir(dp);
    DMESG("Loaded %d saved values (old layout)", count);
}

// ---- background writer -------------------------------------------------------

static LightLock writeLock;
static LightEvent writeWanted, writeDone;
static bool writerStarted;
static uint8_t *pendingData; // newest save waiting to be written (guarded by writeLock)
static int pendingLength;
static char pendingDir[500];
static volatile bool writing;

static void writerThread(void *) {
    for (;;) {
        LightEvent_Wait(&writeWanted);
        for (;;) {
            LightLock_Lock(&writeLock);
            auto data = pendingData;
            int length = pendingLength;
            char dir[500];
            strcpy(dir, pendingDir);
            pendingData = NULL;
            writing = data != NULL;
            LightLock_Unlock(&writeLock);
            if (!data)
                break;

            char tmp[1200], final[1200];
            snprintf(tmp, sizeof(tmp), "%s/save.tmp", dir);
            snprintf(final, sizeof(final), "%s/save.bin", dir);
            FILE *f = fopen(tmp, "wb");
            if (f) {
                bool ok = fwrite(data, 1, length, f) == (size_t)length;
                fclose(f);
                if (ok) {
                    remove(final);
                    rename(tmp, final);
                }
            }
            free(data);
        }
        LightEvent_Signal(&writeDone);
    }
}

void plat_save_store(const char *game, uint8_t *data, int length) {
    if (!writerStarted) {
        writerStarted = true;
        LightLock_Init(&writeLock);
        LightEvent_Init(&writeWanted, RESET_ONESHOT);
        LightEvent_Init(&writeDone, RESET_ONESHOT);
        // Slightly higher priority than the game, so a busy game cannot hold a
        // save back. Nearly all of a write is waiting for the SD card, and the
        // game keeps running during that wait.
        s32 prio = 0x30;
        svcGetThreadPriority(&prio, CUR_THREAD_HANDLE);
        threadCreate(writerThread, NULL, 16 * 1024, prio - 1, -1, true);
    }
    LightLock_Lock(&writeLock);
    free(pendingData); // an older save that was never written is simply replaced
    pendingData = data;
    pendingLength = length;
    gameDir(game, pendingDir, sizeof(pendingDir));
    LightLock_Unlock(&writeLock);
    LightEvent_Signal(&writeWanted);
}

void plat_save_sync() {
    if (!writerStarted)
        return;
    for (;;) {
        LightLock_Lock(&writeLock);
        bool busy = pendingData != NULL || writing;
        LightLock_Unlock(&writeLock);
        if (!busy)
            return;
        LightEvent_WaitTimeout(&writeDone, 50 * 1000 * 1000LL);
    }
}
