// Getting games from the PC over Wi-Fi.
//
// While the PC app (tools/app.js) is open it announces itself on the home
// network once a second: a small UDP broadcast "MCA3DS <port>" to port
// 47900. The library listens for that, then asks the PC app over HTTP for
// the list of library files (with a fingerprint of each) and downloads the
// ones that are new or changed into sdmc:/3ds/makecode-arcade/.
//
// Downloads go to a temporary file first and replace the old one only when
// complete, so a dropped connection never leaves a broken game behind.
// Fingerprints of what was downloaded are kept in sync.dat.

#include <3ds.h>

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <malloc.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include <string>
#include <vector>

#include "sync.h"

#define LIB_DIR "sdmc:/3ds/makecode-arcade"
#define ANNOUNCE_PORT 47900
#define SOC_BUFFER_SIZE 0x100000

struct RemoteFile {
    std::string path; // relative to the library folder, '/' separated
    unsigned long size;
    std::string hash;
};

struct Known {
    std::string path, hash;
};

static std::vector<Known> loadKnown() {
    std::vector<Known> out;
    FILE *f = fopen(LIB_DIR "/sync.dat", "r");
    if (!f)
        return out;
    char line[600];
    while (fgets(line, sizeof(line), f)) {
        line[strcspn(line, "\r\n")] = 0;
        char *tab = strchr(line, '\t');
        if (!tab)
            continue;
        *tab = 0;
        out.push_back({tab + 1, line}); // stored as "hash\tpath"
    }
    fclose(f);
    return out;
}

static void saveKnown(const std::vector<Known> &known) {
    FILE *f = fopen(LIB_DIR "/sync.tmp", "w");
    if (!f)
        return;
    for (auto &k : known)
        fprintf(f, "%s\t%s\n", k.hash.c_str(), k.path.c_str());
    fclose(f);
    remove(LIB_DIR "/sync.dat");
    rename(LIB_DIR "/sync.tmp", LIB_DIR "/sync.dat");
}

// Waits up to `ms` for the socket to be readable. Returns false on timeout.
static bool waitReadable(int sock, int ms) {
    struct pollfd p = {sock, POLLIN, 0};
    return poll(&p, 1, ms) > 0 && (p.revents & POLLIN);
}

// Listens for the PC app's announcement. Returns false if cancelled.
static bool findPC(SyncStatus status, in_addr *pcAddr, int *pcPort) {
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0)
        return false;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(ANNOUNCE_PORT);
    addr.sin_addr.s_addr = INADDR_ANY;
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(sock);
        return false;
    }
    bool found = false;
    while (!found) {
        if (!status("Looking for your PC...", "Open the MakeCode 3DS app on the PC.   B: cancel")) {
            close(sock);
            return false;
        }
        if (!waitReadable(sock, 200))
            continue;
        char buf[64];
        struct sockaddr_in from;
        socklen_t fromLen = sizeof(from);
        int n = recvfrom(sock, buf, sizeof(buf) - 1, 0, (struct sockaddr *)&from, &fromLen);
        if (n <= 0)
            continue;
        buf[n] = 0;
        int port;
        if (sscanf(buf, "MCA3DS %d", &port) == 1 && port > 0 && port < 65536) {
            *pcAddr = from.sin_addr;
            *pcPort = port;
            found = true;
        }
    }
    close(sock);
    return true;
}

// Sends an HTTP GET and returns the connected socket positioned at the start
// of the body, with the body length in *length. -1 on failure.
static int httpGet(in_addr pc, int port, const char *path, unsigned long *length) {
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0)
        return -1;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr = pc;
    if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(sock);
        return -1;
    }
    char req[300];
    int len = snprintf(req, sizeof(req), "GET %s HTTP/1.0\r\nHost: pc\r\n\r\n", path);
    if (send(sock, req, len, 0) != len) {
        close(sock);
        return -1;
    }
    // Read the headers one byte at a time (they are short) up to the blank line.
    std::string head;
    char c;
    while (head.size() < 4096) {
        if (!waitReadable(sock, 10000) || recv(sock, &c, 1, 0) != 1) {
            close(sock);
            return -1;
        }
        head += c;
        if (head.size() >= 4 && head.compare(head.size() - 4, 4, "\r\n\r\n") == 0)
            break;
    }
    if (head.compare(0, 12, "HTTP/1.1 200") != 0 && head.compare(0, 12, "HTTP/1.0 200") != 0) {
        close(sock);
        return -1;
    }
    *length = 0;
    size_t p = head.find("Content-Length:");
    if (p == std::string::npos)
        p = head.find("content-length:");
    if (p != std::string::npos)
        *length = strtoul(head.c_str() + p + 15, NULL, 10);
    return sock;
}

static bool readAll(int sock, char *buf, unsigned long size) {
    unsigned long got = 0;
    while (got < size) {
        if (!waitReadable(sock, 10000))
            return false;
        int n = recv(sock, buf + got, size - got > 65536 ? 65536 : size - got, 0);
        if (n <= 0)
            return false;
        got += n;
    }
    return true;
}

// The same fingerprint the PC app gives a file (tools/app.js): FNV-1a of
// the contents as 8 hex digits, then the size in hex. Used to recognise
// files that are already on the SD card (copied by hand, say), so they are
// not downloaded again.
static std::string localFingerprint(const std::string &path, SyncStatus status, const char *line1) {
    FILE *f = fopen(path.c_str(), "rb");
    if (!f)
        return "";
    static unsigned char buf[65536];
    uint32_t h = 0x811c9dc5;
    unsigned long size = 0;
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        for (size_t i = 0; i < n; ++i)
            h = (h ^ buf[i]) * 0x01000193u;
        size += n;
        if (!status(line1, path.c_str() + strlen(LIB_DIR) + 1))
            break;
    }
    fclose(f);
    char out[40];
    snprintf(out, sizeof(out), "%08lx%lx", (unsigned long)h, size);
    return out;
}

// Makes every folder on the way to `path`.
static void makeParents(const std::string &path) {
    for (size_t i = strlen(LIB_DIR) + 1; i < path.size(); ++i)
        if (path[i] == '/')
            mkdir(path.substr(0, i).c_str(), 0777);
}

static bool download(in_addr pc, int port, int index, const RemoteFile &rf, SyncStatus status, const char *line1) {
    char url[64];
    snprintf(url, sizeof(url), "/sync/file/%d", index);
    unsigned long length;
    int sock = httpGet(pc, port, url, &length);
    if (sock < 0)
        return false;
    std::string final = std::string(LIB_DIR "/") + rf.path, tmp = final + ".part";
    makeParents(final);
    FILE *f = fopen(tmp.c_str(), "wb");
    if (!f) {
        close(sock);
        return false;
    }
    static char buf[65536];
    unsigned long got = 0;
    bool ok = true;
    while (got < length) {
        if (!waitReadable(sock, 10000)) {
            ok = false;
            break;
        }
        int n = recv(sock, buf, sizeof(buf), 0);
        if (n <= 0) {
            ok = false;
            break;
        }
        fwrite(buf, 1, n, f);
        got += n;
        char line2[80];
        snprintf(line2, sizeof(line2), "%s  %lu / %lu KB", rf.path.c_str(), got / 1024, length / 1024);
        if (!status(line1, line2)) {
            ok = false;
            break;
        }
    }
    fclose(f);
    close(sock);
    if (!ok || got != length) {
        remove(tmp.c_str());
        return false;
    }
    remove(final.c_str());
    rename(tmp.c_str(), final.c_str());
    return true;
}

int syncFromPC(SyncStatus status) {
    // Wi-Fi must be connected (the 3DS gets an address from the router).
    u32 wifi = 0;
    if (R_FAILED(ACU_GetWifiStatus(&wifi)) || wifi == 0) {
        while (status("Wi-Fi is not connected.", "Turn on Wi-Fi in the system settings.   B: back")) {
        }
        return -1;
    }
    u32 *socMem = (u32 *)memalign(0x1000, SOC_BUFFER_SIZE);
    if (!socMem || R_FAILED(socInit(socMem, SOC_BUFFER_SIZE))) {
        free(socMem);
        while (status("Could not start networking.", "B: back")) {
        }
        return -1;
    }

    int changed = -1;
    in_addr pc;
    int port;
    if (findPC(status, &pc, &port)) {
        changed = 0;
        status("Found your PC.", "Getting the list of games...");
        // The list: one line per file, "size<TAB>fingerprint<TAB>path".
        unsigned long length;
        int sock = httpGet(pc, port, "/sync/manifest", &length);
        std::vector<RemoteFile> files;
        if (sock >= 0 && length > 0 && length < 4 * 1024 * 1024) {
            std::vector<char> text(length + 1);
            if (readAll(sock, text.data(), length)) {
                text[length] = 0;
                char *save = NULL;
                for (char *line = strtok_r(text.data(), "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
                    char *t1 = strchr(line, '\t'), *t2 = t1 ? strchr(t1 + 1, '\t') : NULL;
                    if (!t2)
                        continue;
                    *t1 = *t2 = 0;
                    files.push_back({t2 + 1, strtoul(line, NULL, 10), t1 + 1});
                }
            }
        }
        if (sock >= 0)
            close(sock);

        if (files.empty()) {
            while (status("The PC app sent no games.", "Build some games first.   B: back")) {
            }
            changed = -1;
        } else {
            auto known = loadKnown();
            std::vector<int> wanted;
            bool learned = false;
            for (int i = 0; i < (int)files.size(); ++i) {
                bool have = false;
                struct stat st;
                std::string local = std::string(LIB_DIR "/") + files[i].path;
                bool exists = stat(local.c_str(), &st) == 0;
                Known *entry = NULL;
                for (auto &k : known)
                    if (k.path == files[i].path)
                        entry = &k;
                if (entry && entry->hash == files[i].hash && exists)
                    have = true;
                // Not downloaded by us, or changed since: if a file of the same
                // size is there, check whether it is in fact the same file.
                if (!have && exists && (unsigned long)st.st_size == files[i].size &&
                    localFingerprint(local, status, "Checking games already on the SD card...") == files[i].hash) {
                    have = true;
                    if (entry)
                        entry->hash = files[i].hash;
                    else
                        known.push_back({files[i].path, files[i].hash});
                    learned = true;
                }
                if (!have)
                    wanted.push_back(i);
            }
            if (learned)
                saveKnown(known);
            int done = 0, failed = 0;
            for (int i : wanted) {
                char line1[80];
                snprintf(line1, sizeof(line1), "Downloading %d of %d...   B: stop", done + failed + 1, (int)wanted.size());
                if (download(pc, port, i, files[i], status, line1)) {
                    done++;
                    bool updated = false;
                    for (auto &k : known)
                        if (k.path == files[i].path) {
                            k.hash = files[i].hash;
                            updated = true;
                        }
                    if (!updated)
                        known.push_back({files[i].path, files[i].hash});
                    saveKnown(known);
                } else {
                    failed++;
                    if (!status(line1, "")) // cancelled
                        break;
                }
            }
            changed = done;
            char msg[80];
            if (wanted.empty())
                snprintf(msg, sizeof(msg), "Everything is up to date.");
            else
                snprintf(msg, sizeof(msg), "Got %d file%s%s.", done, done == 1 ? "" : "s",
                         failed ? " (some failed; try again)" : "");
            while (status(msg, "B: back to the library")) {
            }
        }
    }

    socExit();
    free(socMem);
    return changed;
}
