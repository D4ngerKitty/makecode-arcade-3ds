// See hbldr.h. Shared by the game player and the library app.

#include <3ds.h>
#include <string.h>

#include "hbldr.h"

bool hbldr_set_next(const char *path, int argc, const char *const *argv) {
    if (!path || strncmp(path, "sdmc:/", 6) != 0)
        return false;
    Handle loader;
    if (R_FAILED(svcConnectToPort(&loader, "hb:ldr")))
        return false;

    // Which program to run next: its path without the "sdmc:" prefix.
    const char *target = path + 5;
    u32 *cmd = getThreadCommandBuffer();
    cmd[0] = IPC_MakeHeader(2, 0, 2); // SetTarget
    cmd[1] = IPC_Desc_StaticBuffer(strlen(target) + 1, 0);
    cmd[2] = (u32)target;
    Result rc = svcSendSyncRequest(loader);
    if (R_SUCCEEDED(rc))
        rc = cmd[1];

    // Its arguments: a count, then the strings one after another.
    static char args[0x400];
    memset(args, 0, sizeof(args));
    *(u32 *)args = 0;
    size_t pos = 4;
    for (int i = 0; i < argc && argv[i]; ++i) {
        size_t len = strlen(argv[i]) + 1;
        if (pos + len > sizeof(args))
            break;
        memcpy(args + pos, argv[i], len);
        pos += len;
        (*(u32 *)args)++;
    }
    if (R_SUCCEEDED(rc)) {
        cmd = getThreadCommandBuffer();
        cmd[0] = IPC_MakeHeader(3, 0, 2); // SetArgv
        cmd[1] = IPC_Desc_StaticBuffer(sizeof(args), 1);
        cmd[2] = (u32)args;
        rc = svcSendSyncRequest(loader);
        if (R_SUCCEEDED(rc))
            rc = cmd[1];
    }
    svcCloseHandle(loader);
    return R_SUCCEEDED(rc);
}
