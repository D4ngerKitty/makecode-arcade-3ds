// Starting another .3dsx program, through the homebrew loader (Luma3DS's
// "hb:ldr" service, which the Homebrew Launcher also uses). Shared by the
// game player and the library app.
#ifndef __HBLDR_H
#define __HBLDR_H

// Asks the loader to start the .3dsx at `path` ("sdmc:/3ds/...") with these
// arguments as soon as this program exits. argv[0] should be the path itself.
// Returns false if the loader could not be reached (the caller then simply
// exits as normal). Does not exit by itself.
bool hbldr_set_next(const char *path, int argc, const char *const *argv);

#endif
