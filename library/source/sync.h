// Getting games from the PC over Wi-Fi (see sync.cpp).
#ifndef __SYNC_H
#define __SYNC_H

// Shows two lines of progress and returns false if the user pressed B to
// cancel / go back. Called often while syncing.
typedef bool (*SyncStatus)(const char *line1, const char *line2);

// Finds the PC app on the network and downloads new and changed library
// files. Returns how many files were downloaded, or -1 if it did not get as
// far as talking to the PC.
int syncFromPC(SyncStatus status);

#endif
