// Game saves (MakeCode's "settings" API).
//
// MakeCode's own implementation opens a file for every read and every write.
// On the 3DS the SD card is slow, and games that look at their save data every
// frame dropped to a crawl. So: everything is loaded into memory once, reads
// never touch the card, and writes go to the card only when a value really
// changed: a moment later the whole save is handed to the storage backend as
// one block (see settings_flush), which on the 3DS writes it in the background.

#include "pxt.h"
#include "plat.h"

#include <stdlib.h>
#include <string.h>

namespace settings {

struct Entry {
    Entry *next;
    char *key;
    uint8_t *data;
    int length;
    bool dirty;   // changed since it was last written to storage
    bool deleted; // removed, but the file still has to be deleted
};

#define BUCKETS 256
static Entry *buckets[BUCKETS];
static bool loaded;
static bool anyDirty;

static unsigned hashKey(const char *s) {
    unsigned h = 5381;
    while (*s)
        h = h * 33 + (uint8_t)*s++;
    return h % BUCKETS;
}

static Entry *find(const char *key) {
    for (auto e = buckets[hashKey(key)]; e; e = e->next)
        if (!strcmp(e->key, key))
            return e;
    return NULL;
}

static Entry *findOrAdd(const char *key) {
    auto e = find(key);
    if (e)
        return e;
    e = (Entry *)calloc(1, sizeof(Entry));
    e->key = strdup(key);
    auto h = hashKey(key);
    e->next = buckets[h];
    buckets[h] = e;
    return e;
}

static void store(Entry *e, const uint8_t *data, int length) {
    free(e->data);
    e->data = (uint8_t *)malloc(length + 1);
    memcpy(e->data, data, length);
    e->length = length;
    e->deleted = false;
}

// Called by the storage backend for every saved value it finds.
static void loadOne(const char *key, const uint8_t *data, int length) {
    store(findOrAdd(key), data, length);
}

static void ensureLoaded() {
    if (loaded)
        return;
    loaded = true;
    plat_save_load(pxt::programName()->getUTF8Data(), loadOne);
}

static void markRemoved(Entry *e) {
    if (e->deleted)
        return;
    free(e->data);
    e->data = NULL;
    e->length = 0;
    e->deleted = true;
    e->dirty = true;
    anyDirty = true;
}

int _set(String key, Buffer data) {
    ensureLoaded();
    auto e = findOrAdd(key->getUTF8Data());
    // Many games write the same value over and over; that costs nothing here.
    if (e->data && !e->deleted && e->length == (int)data->length && !memcmp(e->data, data->data, data->length))
        return 0;
    store(e, data->data, data->length);
    e->dirty = true;
    anyDirty = true;
    return 0;
}

int _remove(String key) {
    ensureLoaded();
    auto e = find(key->getUTF8Data());
    if (e)
        markRemoved(e);
    return 0;
}

bool _exists(String key) {
    ensureLoaded();
    auto e = find(key->getUTF8Data());
    return e && !e->deleted;
}

Buffer _get(String key) {
    ensureLoaded();
    auto e = find(key->getUTF8Data());
    if (!e || e->deleted)
        return NULL;
    return mkBuffer(e->data, e->length);
}

// Removes everything the game saved, but not system values (names starting "#").
void _userClean() {
    ensureLoaded();
    for (int i = 0; i < BUCKETS; ++i)
        for (auto e = buckets[i]; e; e = e->next)
            if (e->key[0] != '#')
                markRemoved(e);
}

RefCollection *_list(String prefix) {
    ensureLoaded();
    auto res = Array_::mk();
    registerGCObj(res);
    auto prefData = prefix->getUTF8Data();
    auto prefLen = prefix->getUTF8Size();
    auto wantsInternal = prefData[0] == '#';
    for (int i = 0; i < BUCKETS; ++i)
        for (auto e = buckets[i]; e; e = e->next) {
            if (e->deleted)
                continue;
            if (!wantsInternal && e->key[0] == '#')
                continue;
            if (strncmp(e->key, prefData, prefLen) != 0)
                continue;
            auto str = mkString(e->key, -1);
            registerGCObj(str);
            res->head.push((TValue)str);
            unregisterGCObj(str);
        }
    unregisterGCObj(res);
    return res;
}

} // namespace settings

// Hands the whole save to storage if anything changed. Called about once a
// second while there are changes, and when the game exits or restarts.
//
// The save is one block: "MCSV", a count, then for each value the length of
// its name (2 bytes), the length of its data (4 bytes), the name and the data.
void settings_flush() {
    using namespace settings;
    if (!anyDirty)
        return;
    anyDirty = false;

    int size = 8, count = 0;
    for (int i = 0; i < BUCKETS; ++i)
        for (auto e = buckets[i]; e; e = e->next) {
            e->dirty = false;
            if (e->deleted)
                continue;
            size += 6 + strlen(e->key) + e->length;
            count++;
        }

    auto blob = (uint8_t *)malloc(size);
    memcpy(blob, "MCSV", 4);
    memcpy(blob + 4, &count, 4);
    auto p = blob + 8;
    for (int i = 0; i < BUCKETS; ++i)
        for (auto e = buckets[i]; e; e = e->next) {
            if (e->deleted)
                continue;
            uint16_t keyLen = strlen(e->key);
            uint32_t dataLen = e->length;
            memcpy(p, &keyLen, 2);
            memcpy(p + 2, &dataLen, 4);
            memcpy(p + 6, e->key, keyLen);
            memcpy(p + 6 + keyLen, e->data, dataLen);
            p += 6 + keyLen + dataLen;
        }
    plat_save_store(pxt::programName()->getUTF8Data(), blob, size);
}

// For storage backends: reads a block written by settings_flush, calling
// add() for each value. Returns false if the block is damaged.
bool settings_parse(const uint8_t *blob, int size, void (*add)(const char *key, const uint8_t *data, int length)) {
    if (size < 8 || memcmp(blob, "MCSV", 4) != 0)
        return false;
    int count;
    memcpy(&count, blob + 4, 4);
    auto p = blob + 8, end = blob + size;
    char key[600];
    for (int i = 0; i < count; ++i) {
        if (p + 6 > end)
            return false;
        uint16_t keyLen;
        uint32_t dataLen;
        memcpy(&keyLen, p, 2);
        memcpy(&dataLen, p + 2, 4);
        if (keyLen >= sizeof(key) || p + 6 + keyLen + dataLen > end)
            return false;
        memcpy(key, p + 6, keyLen);
        key[keyLen] = 0;
        add(key, p + 6 + keyLen, dataLen);
        p += 6 + keyLen + dataLen;
    }
    return true;
}

bool settings_need_flush() {
    return settings::anyDirty;
}
