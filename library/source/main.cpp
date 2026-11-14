// Makecode Arcade on 3ds - the game library.
//
// Top screen:    the selected game's art in a square on the left, its details
//                (name, author, version, tags, description) on the right.
// Bottom screen: a start menu of folders (all games, favourites, most
//                played, recently added, tags, authors) and a "Get games
//                from PC" button. Tags and Authors each open a list of
//                their folders; picking a folder shows its games. While
//                choosing a folder, the top screen previews what is in it.
// Picking a game starts its .3dsx through the homebrew loader; the game is
// told where the library is, so it can come back here.
//
// Files, all in sdmc:/3ds/makecode-arcade/ (made by tools/build-library.js):
//   games/<id>/game.3dsx    the game
//   games/<id>/info.txt     name=, author=, version=, tags= (comma-separated), description=
//   games/<id>/art.art      its art (optional; converted from a PNG)
//   placeholder.art         art for games without any (optional)
//   theme.cfg               colours
//   library.dat             play counts, favourites, last game (written here)

#include <3ds.h>

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>

#include <algorithm>
#include <string>
#include <vector>

#include "hbldr.h"
#include "sync.h"

#define LIB_DIR "sdmc:/3ds/makecode-arcade"
#define APP_NAME "Makecode Arcade on 3ds"

// The 3DS system's own 8x8 pixel font (part of libctru): 256 characters,
// 8 bytes each, one byte per row, leftmost pixel in the top bit.
extern "C" const u8 default_font_bin[];

// ---- colours (theme.cfg) -------------------------------------------------------

struct Rgb {
    u8 r, g, b;
};
static Rgb colBackground = {0x05, 0x08, 0x1c};
static Rgb colText = {0xff, 0xff, 0xff};
static Rgb colDim = {0x80, 0x88, 0xa8};
static Rgb colHighlight = {0x1e, 0x2a, 0x5a};
static Rgb colAccent = {0xff, 0xd8, 0x40};

static void loadTheme() {
    FILE *f = fopen(LIB_DIR "/theme.cfg", "r");
    if (!f)
        return;
    char line[128];
    while (fgets(line, sizeof(line), f)) {
        char key[64];
        unsigned v;
        if (sscanf(line, " %63[a-z] = #%x", key, &v) != 2 && sscanf(line, " %63[a-z] = %x", key, &v) != 2)
            continue;
        Rgb c = {(u8)(v >> 16), (u8)(v >> 8), (u8)v};
        if (!strcmp(key, "background"))
            colBackground = c;
        else if (!strcmp(key, "text"))
            colText = c;
        else if (!strcmp(key, "dim"))
            colDim = c;
        else if (!strcmp(key, "highlight"))
            colHighlight = c;
        else if (!strcmp(key, "accent"))
            colAccent = c;
    }
    fclose(f);
}

// ---- drawing -------------------------------------------------------------------
// The framebuffers are stored sideways: column after column, each from the
// bottom of the screen to the top, 3 bytes per pixel in B, G, R order.

struct Screen {
    u8 *fb;
    int w; // 400 (top) or 320 (bottom); height is always 240
};

static Screen beginScreen(gfxScreen_t which) {
    u16 fbW, fbH;
    Screen s;
    s.fb = gfxGetFramebuffer(which, GFX_LEFT, &fbW, &fbH);
    s.w = fbH;
    return s;
}

static inline void plot(Screen &s, int x, int y, Rgb c) {
    if ((unsigned)x >= (unsigned)s.w || (unsigned)y >= 240)
        return;
    u8 *p = s.fb + (x * 240 + 239 - y) * 3;
    p[0] = c.b;
    p[1] = c.g;
    p[2] = c.r;
}

static void fillRect(Screen &s, int x0, int y0, int w, int h, Rgb c) {
    int x1 = std::min(s.w, x0 + w), y1 = std::min(240, y0 + h);
    x0 = std::max(0, x0);
    y0 = std::max(0, y0);
    for (int x = x0; x < x1; ++x) {
        u8 *p = s.fb + (x * 240 + 239 - (y1 - 1)) * 3;
        for (int y = y0; y < y1; ++y, p += 3) {
            p[0] = c.b;
            p[1] = c.g;
            p[2] = c.r;
        }
    }
}

static void frameRect(Screen &s, int x, int y, int w, int h, Rgb c) {
    fillRect(s, x, y, w, 1, c);
    fillRect(s, x, y + h - 1, w, 1, c);
    fillRect(s, x, y, 1, h, c);
    fillRect(s, x + w - 1, y, 1, h, c);
}

// Draws text; each character is 8x8 pixels times `scale`. Returns the width.
static int drawText(Screen &s, int x, int y, const char *text, Rgb c, int scale = 1) {
    int x0 = x;
    for (const u8 *t = (const u8 *)text; *t; ++t, x += 8 * scale) {
        const u8 *glyph = default_font_bin + *t * 8;
        for (int row = 0; row < 8; ++row)
            for (int col = 0; col < 8; ++col)
                if (glyph[row] & (0x80 >> col)) {
                    if (scale == 1)
                        plot(s, x + col, y + row, c);
                    else
                        fillRect(s, x + col * scale, y + row * scale, scale, scale, c);
                }
    }
    return x - x0;
}

// Text cut to at most `maxChars`, with ".." at the end if it was cut.
static std::string fit(const std::string &text, size_t maxChars) {
    if (text.size() <= maxChars)
        return text;
    return text.substr(0, maxChars > 2 ? maxChars - 2 : 0) + "..";
}

// Splits text into lines of at most `width` characters, breaking at spaces.
static std::vector<std::string> wrap(const std::string &text, size_t width) {
    std::vector<std::string> lines;
    std::string line, word;
    auto flushWord = [&]() {
        while (word.size() > width) { // a word longer than a whole line
            if (!line.empty()) {
                lines.push_back(line);
                line.clear();
            }
            lines.push_back(word.substr(0, width));
            word = word.substr(width);
        }
        if (word.empty())
            return;
        if (line.empty())
            line = word;
        else if (line.size() + 1 + word.size() <= width)
            line += " " + word;
        else {
            lines.push_back(line);
            line = word;
        }
        word.clear();
    };
    for (char ch : text) {
        if (ch == ' ' || ch == '\n') {
            flushWord();
            if (ch == '\n' && !line.empty()) {
                lines.push_back(line);
                line.clear();
            }
        } else
            word += ch;
    }
    flushWord();
    if (!line.empty())
        lines.push_back(line);
    return lines;
}

// ---- art (.art files: "ART1", width, height (16-bit each), then RGBA rows) --------

struct Art {
    int w = 0, h = 0;
    std::vector<u8> rgba;
};

static bool loadArt(const std::string &path, Art &art) {
    FILE *f = fopen(path.c_str(), "rb");
    if (!f)
        return false;
    u8 head[8];
    bool ok = fread(head, 1, 8, f) == 8 && !memcmp(head, "ART1", 4);
    if (ok) {
        art.w = head[4] | head[5] << 8;
        art.h = head[6] | head[7] << 8;
        ok = art.w > 0 && art.h > 0 && art.w <= 1024 && art.h <= 1024;
    }
    if (ok) {
        art.rgba.resize(art.w * art.h * 4);
        ok = fread(art.rgba.data(), 1, art.rgba.size(), f) == art.rgba.size();
    }
    fclose(f);
    if (!ok)
        art = Art();
    return ok;
}

// Draws art centred in a box, as big as fits. Pixel art is scaled by whole
// numbers so every pixel stays square and sharp.
static void drawArt(Screen &s, const Art &art, int bx, int by, int box) {
    int big = std::max(art.w, art.h);
    int size = big <= box ? big * (box / big) : box;
    int dw = art.w * size / big, dh = art.h * size / big;
    int ox = bx + (box - dw) / 2, oy = by + (box - dh) / 2;
    for (int y = 0; y < dh; ++y) {
        int sy = y * art.h / dh;
        for (int x = 0; x < dw; ++x) {
            const u8 *p = &art.rgba[(sy * art.w + x * art.w / dw) * 4];
            if (p[3] >= 128)
                plot(s, ox + x, oy + y, Rgb{p[0], p[1], p[2]});
        }
    }
}

// ---- games and their stats ------------------------------------------------------------

struct Game {
    std::string id; // folder name
    std::string name, author, version, description; // author: all of them, as written
    std::vector<std::string> tags;
    std::vector<std::string> authors; // author split into each person
    int plays = 0;
    long long lastPlayed = 0, added = 0;
    bool favourite = false;
};

static std::vector<Game> games;
static std::string lastGameId;
static Art placeholderArt;
static bool havePlaceholder;

static std::string gameDir(const Game &g) {
    return std::string(LIB_DIR "/games/") + g.id;
}

static void loadInfo(Game &g) {
    g.name = g.id;
    FILE *f = fopen((gameDir(g) + "/info.txt").c_str(), "r");
    if (!f)
        return;
    char line[1024];
    while (fgets(line, sizeof(line), f)) {
        line[strcspn(line, "\r\n")] = 0;
        char *eq = strchr(line, '=');
        if (!eq)
            continue;
        *eq = 0;
        std::string key = line, value = eq + 1;
        if (key == "name" && !value.empty())
            g.name = value;
        else if (key == "author") {
            // Several people: "Ann, Bob" or "Ann & Bob". Each gets the game
            // in their own folder; the details show them all.
            g.author = value;
            std::string name;
            for (size_t i = 0; i <= value.size(); ++i) {
                if (i == value.size() || value[i] == ',' || value[i] == '&') {
                    name.erase(0, name.find_first_not_of(' '));
                    name.erase(name.find_last_not_of(' ') + 1);
                    if (!name.empty())
                        g.authors.push_back(name);
                    name.clear();
                } else
                    name += value[i];
            }
        }
        else if (key == "version")
            g.version = value;
        else if (key == "tags" || key == "genre") { // "genre" is from older builds
            size_t start = 0;
            while (start <= value.size()) {
                size_t end = value.find(',', start);
                if (end == std::string::npos)
                    end = value.size();
                std::string tag = value.substr(start, end - start);
                tag.erase(0, tag.find_first_not_of(' '));
                tag.erase(tag.find_last_not_of(' ') + 1);
                if (!tag.empty())
                    g.tags.push_back(tag);
                start = end + 1;
            }
        }
        else if (key == "description") {
            // "\n" in the file stands for a line break
            size_t p;
            while ((p = value.find("\\n")) != std::string::npos)
                value.replace(p, 2, "\n");
            g.description = value;
        }
    }
    fclose(f);
}

static void loadStats() {
    FILE *f = fopen(LIB_DIR "/library.dat", "r");
    if (!f)
        return;
    char line[512];
    while (fgets(line, sizeof(line), f)) {
        line[strcspn(line, "\r\n")] = 0;
        char id[300];
        int plays, fav;
        long long last, added;
        if (!strncmp(line, "last\t", 5)) {
            lastGameId = line + 5;
        } else if (sscanf(line, "%299[^\t]\t%d\t%lld\t%d\t%lld", id, &plays, &last, &fav, &added) == 5) {
            for (auto &g : games)
                if (g.id == id) {
                    g.plays = plays;
                    g.lastPlayed = last;
                    g.favourite = fav != 0;
                    g.added = added;
                }
        }
    }
    fclose(f);
}

static void saveStats() {
    FILE *f = fopen(LIB_DIR "/library.tmp", "w");
    if (!f)
        return;
    fprintf(f, "last\t%s\n", lastGameId.c_str());
    for (auto &g : games)
        fprintf(f, "%s\t%d\t%lld\t%d\t%lld\n", g.id.c_str(), g.plays, g.lastPlayed, g.favourite ? 1 : 0, g.added);
    fclose(f);
    remove(LIB_DIR "/library.dat");
    rename(LIB_DIR "/library.tmp", LIB_DIR "/library.dat");
}

static void scanGames() {
    DIR *d = opendir(LIB_DIR "/games");
    if (d) {
        while (dirent *e = readdir(d)) {
            if (e->d_name[0] == '.')
                continue;
            Game g;
            g.id = e->d_name;
            struct stat st;
            if (stat((gameDir(g) + "/game.3dsx").c_str(), &st) != 0)
                continue;
            loadInfo(g);
            games.push_back(g);
        }
        closedir(d);
    }
    loadStats();
    // Games seen for the first time count as added now.
    bool changed = false;
    for (auto &g : games)
        if (!g.added) {
            g.added = time(NULL);
            changed = true;
        }
    if (changed)
        saveStats();
    std::sort(games.begin(), games.end(),
              [](const Game &a, const Game &b) { return strcasecmp(a.name.c_str(), b.name.c_str()) < 0; });
}

// ---- folders ----------------------------------------------------------------------------

struct Folder {
    std::string title; // shown at the top of its game list
    std::string label; // shown in a list of folders
    std::vector<int> items; // indexes into `games`
};
static std::vector<Folder> folders;
static std::vector<int> tagFolders, authorFolders; // indexes into `folders`

static bool lessNoCase(const std::string &a, const std::string &b) {
    return strcasecmp(a.c_str(), b.c_str()) < 0;
}

static void buildFolders() {
    folders.clear();
    tagFolders.clear();
    authorFolders.clear();
    std::vector<int> all;
    for (int i = 0; i < (int)games.size(); ++i)
        all.push_back(i);

    folders.push_back({"All Games", "All Games", all});

    Folder fav{"Favourites", "Favourites", {}};
    for (int i : all)
        if (games[i].favourite)
            fav.items.push_back(i);
    folders.push_back(fav);

    Folder most{"Most Played", "Most Played", {}};
    for (int i : all)
        if (games[i].plays > 0)
            most.items.push_back(i);
    std::stable_sort(most.items.begin(), most.items.end(), [](int a, int b) { return games[a].plays > games[b].plays; });
    folders.push_back(most);

    Folder recent{"Recently Added", "Recently Added", all};
    std::stable_sort(recent.items.begin(), recent.items.end(),
                     [](int a, int b) { return games[a].added > games[b].added; });
    folders.push_back(recent);

    // One folder per tag (the same tag written in different capitals counts once).
    std::vector<std::string> tags;
    for (auto &g : games)
        for (auto &t : g.tags) {
            bool seen = false;
            for (auto &u : tags)
                if (!strcasecmp(u.c_str(), t.c_str()))
                    seen = true;
            if (!seen)
                tags.push_back(t);
        }
    std::sort(tags.begin(), tags.end(), lessNoCase);
    for (auto &t : tags) {
        Folder f{"Tags > " + t, t, {}};
        for (int i : all)
            for (auto &u : games[i].tags)
                if (!strcasecmp(u.c_str(), t.c_str())) {
                    f.items.push_back(i);
                    break;
                }
        tagFolders.push_back(folders.size());
        folders.push_back(f);
    }

    // One folder per person; a game made by several people is in each of their
    // folders (the same name in different capitals counts once).
    std::vector<std::string> authors;
    for (auto &g : games)
        for (auto &a : g.authors) {
            bool seen = false;
            for (auto &b : authors)
                if (!strcasecmp(a.c_str(), b.c_str()))
                    seen = true;
            if (!seen)
                authors.push_back(a);
        }
    std::sort(authors.begin(), authors.end(), lessNoCase);
    for (auto &a : authors) {
        Folder f{"Authors > " + a, a, {}};
        for (int i : all)
            for (auto &b : games[i].authors)
                if (!strcasecmp(a.c_str(), b.c_str())) {
                    f.items.push_back(i);
                    break;
                }
        authorFolders.push_back(folders.size());
        folders.push_back(f);
    }
}

// ---- the menu ------------------------------------------------------------------------------
// Start screen: the main folders, then "Tags" and "Authors" (each opening a
// list of their folders), and a "Get games from PC" button at the bottom.

enum { GROUP_NONE, GROUP_TAGS, GROUP_AUTHORS };

struct MenuEntry {
    std::string label;
    int folder; // index into `folders`, or -1 for a group
    int group;  // GROUP_TAGS / GROUP_AUTHORS for the group entries
};
static std::vector<MenuEntry> menu;

static void buildMenu() {
    menu.clear();
    for (int i = 0; i < 4; ++i)
        menu.push_back({folders[i].label, i, GROUP_NONE});
    menu.push_back({"Tags", -1, GROUP_TAGS});
    menu.push_back({"Authors", -1, GROUP_AUTHORS});
}

static const std::vector<int> &groupFolders(int group) {
    return group == GROUP_TAGS ? tagFolders : authorFolders;
}

// ---- lists (menu, sub-folders and games all scroll the same way) -----------------------------

struct ListState {
    int cursor = 0, scroll = 0;
};

static void keepVisible(ListState &l, int count, int rows) {
    if (l.cursor >= count)
        l.cursor = count - 1;
    if (l.cursor < 0)
        l.cursor = 0;
    if (l.cursor < l.scroll)
        l.scroll = l.cursor;
    if (l.cursor >= l.scroll + rows)
        l.scroll = l.cursor - rows + 1;
    l.scroll = std::min(std::max(l.scroll, 0), std::max(0, count - rows));
}

// Up/Down move by one, Left/Right by a page.
static void moveWithButtons(ListState &l, int count, int rows, u32 repeat) {
    int before = l.cursor;
    if (repeat & (KEY_DUP | KEY_CPAD_UP))
        l.cursor--;
    if (repeat & (KEY_DDOWN | KEY_CPAD_DOWN))
        l.cursor++;
    if (repeat & KEY_DLEFT)
        l.cursor -= rows;
    if (repeat & KEY_DRIGHT)
        l.cursor += rows;
    if (l.cursor != before)
        keepVisible(l, count, rows);
}

// Touch on a list: tap a row to select it, tap it again to choose it, drag to
// scroll. Returns the chosen row, or -1.
static struct {
    bool down = false, dragging = false;
    int startY = 0, startScroll = 0, row = -1;
} touch;

static int touchList(ListState &l, int count, int top, int rowH, int rows, u32 held, const touchPosition &t) {
    if (held & KEY_TOUCH) {
        if (!touch.down) {
            touch.down = true;
            touch.dragging = false;
            touch.startY = t.py;
            touch.startScroll = l.scroll;
            touch.row = (t.py >= top && t.py < top + rows * rowH) ? (t.py - top) / rowH : -1;
        } else if (touch.row >= 0) {
            int dy = t.py - touch.startY;
            if (abs(dy) > 6)
                touch.dragging = true;
            if (touch.dragging)
                l.scroll = std::min(std::max(touch.startScroll - dy / rowH, 0), std::max(0, count - rows));
        }
        return -1;
    }
    int chosen = -1;
    if (touch.down && !touch.dragging && touch.row >= 0 && l.scroll + touch.row < count) {
        int idx = l.scroll + touch.row;
        if (idx == l.cursor)
            chosen = idx;
        l.cursor = idx;
    }
    touch.down = false;
    return chosen;
}

// ---- screens --------------------------------------------------------------------------

#define ART_BOX 160
#define HEADER_H 22
#define GAME_TOP 28
#define GAME_ROW_H 16
#define GAME_ROWS 12
#define MENU_TOP 30
#define MENU_ROW_H 24
#define MENU_ROWS 6 // on the start screen, above the button
#define SUB_ROWS 8  // in a list of tags or authors
#define BUTTON_Y 190
#define BUTTON_H 26

enum View { VIEW_MENU, VIEW_SUB, VIEW_GAMES };
static View view = VIEW_MENU;
static ListState menuList, subList, gameList;
static int subGroup = GROUP_NONE; // which group the sub-folder list shows
static int folderIndex = 0;       // the folder whose games are shown
static View gamesBack = VIEW_MENU; // where B goes from the game list

static int artGame = -2; // which game `currentArt` belongs to
static Art currentArt;
static bool currentHasArt;

static Folder &folder() {
    return folders[folderIndex];
}

static int selectedGame() {
    auto &items = folder().items;
    return gameList.cursor < (int)items.size() ? items[gameList.cursor] : -1;
}

static bool buttonSelected() {
    return view == VIEW_MENU && menuList.cursor == (int)menu.size();
}

// Draws a game's art (or the placeholder) in the square box on the top screen.
static void drawGameArt(Screen &s, int gi, int bx, int by) {
    frameRect(s, bx - 2, by - 2, ART_BOX + 4, ART_BOX + 4, colDim);
    if (gi < 0)
        return;
    if (artGame != gi) {
        artGame = gi;
        currentHasArt = loadArt(gameDir(games[gi]) + "/art.art", currentArt);
    }
    if (currentHasArt)
        drawArt(s, currentArt, bx, by, ART_BOX);
    else if (havePlaceholder)
        drawArt(s, placeholderArt, bx, by, ART_BOX);
    else
        drawText(s, bx + ART_BOX / 2 - 16, by + ART_BOX / 2 - 16, "?", colDim, 4);
}

// Top screen in the game list: the selected game's art and details.
static void drawTopGame(Screen &s) {
    int gi = selectedGame();
    int bx = 16, by = 40;
    drawGameArt(s, gi, bx, by);
    if (gi < 0) {
        drawText(s, 196, by, "No games here yet", colDim);
        return;
    }
    const Game &g = games[gi];

    // Details: name in double size, then the rest.
    int x = 196, y = by, width = s.w - x - 8;
    auto nameLines = wrap(g.name, width / 16);
    for (size_t i = 0; i < nameLines.size() && i < 3; ++i, y += 18)
        drawText(s, x, y, nameLines[i].c_str(), colText, 2);
    y += 8;
    auto detail = [&](const char *label, const std::string &value) {
        drawText(s, x, y, label, colDim);
        drawText(s, x + 72, y, fit(value.empty() ? "-" : value, (width - 72) / 8).c_str(), colText);
        y += 12;
    };
    std::string authorText;
    for (auto &a : g.authors)
        authorText += (authorText.empty() ? "" : ", ") + a;
    auto authorLines = wrap(authorText.empty() ? "-" : authorText, (width - 72) / 8);
    drawText(s, x, y, g.authors.size() > 1 ? "Authors" : "Author", colDim);
    for (size_t i = 0; i < authorLines.size() && i < 2; ++i, y += 10)
        drawText(s, x + 72, y, (i == 1 && authorLines.size() > 2 ? fit(authorLines[i] + "...", (width - 72) / 8) : authorLines[i]).c_str(), colText);
    y += 2;
    detail("Version", g.version);
    std::string tagText;
    for (auto &t : g.tags)
        tagText += (tagText.empty() ? "" : ", ") + t;
    auto tagLines = wrap(tagText.empty() ? "-" : tagText, (width - 72) / 8);
    drawText(s, x, y, "Tags", colDim);
    for (size_t i = 0; i < tagLines.size() && i < 2; ++i, y += 10)
        drawText(s, x + 72, y, (i == 1 && tagLines.size() > 2 ? fit(tagLines[i] + "...", (width - 72) / 8) : tagLines[i]).c_str(), colText);
    y += 2;
    char played[48];
    snprintf(played, sizeof(played), g.plays == 1 ? "%d time" : "%d times", g.plays);
    detail("Played", played);
    if (g.favourite) {
        drawText(s, x, y, "Favourite", colAccent);
        y += 12;
    }
    y += 6;
    auto desc = wrap(g.description, width / 8);
    for (size_t i = 0; i < desc.size() && y <= 230; ++i, y += 10)
        drawText(s, x, y, desc[i].c_str(), colDim);
}

// Top screen while choosing a folder: a preview of what is inside.
static void drawTopFolder(Screen &s, const std::string &name, const std::vector<int> &items) {
    int bx = 16, by = 40, x = 196, width = s.w - x - 8;
    drawGameArt(s, items.empty() ? -1 : items[0], bx, by);
    int y = by;
    auto nameLines = wrap(name, width / 16);
    for (size_t i = 0; i < nameLines.size() && i < 2; ++i, y += 18)
        drawText(s, x, y, nameLines[i].c_str(), colText, 2);
    char count[40];
    snprintf(count, sizeof(count), items.size() == 1 ? "%d game" : "%d games", (int)items.size());
    drawText(s, x, y + 4, count, colAccent);
    y += 22;
    for (size_t i = 0; i < items.size() && y <= 222; ++i, y += 12) {
        if (i == 11 && items.size() > 12) {
            drawText(s, x, y, "...", colDim);
            break;
        }
        drawText(s, x, y, fit(games[items[i]].name, width / 8).c_str(), colDim);
    }
}

static void drawTopText(Screen &s, const char *title, const std::vector<std::string> &lines) {
    int y = 60;
    drawText(s, (s.w - (int)strlen(title) * 16) / 2, y, title, colText, 2);
    y += 36;
    for (auto &l : lines) {
        drawText(s, (s.w - (int)l.size() * 8) / 2, y, l.c_str(), l.empty() ? colDim : colDim);
        y += 14;
    }
}

static void drawTop() {
    Screen s = beginScreen(GFX_TOP);
    fillRect(s, 0, 0, s.w, 240, colBackground);
    drawText(s, (s.w - (int)strlen(APP_NAME) * 8) / 2, 8, APP_NAME, colDim);

    if (view == VIEW_GAMES) {
        drawTopGame(s);
    } else if (buttonSelected()) {
        drawTopText(s, "Games from PC",
                    {"Open MakeCode 3DS on your PC", "(double-click MakeCode 3DS.bat),", "then press A here.", "",
                     "New and changed games are downloaded", "over Wi-Fi. The PC and the 3DS must be",
                     "on the same Wi-Fi network."});
    } else if (view == VIEW_MENU) {
        const MenuEntry &e = menu[menuList.cursor];
        if (e.folder >= 0) {
            drawTopFolder(s, folders[e.folder].label, folders[e.folder].items);
        } else {
            auto &list = groupFolders(e.group);
            std::vector<std::string> lines;
            char count[48];
            snprintf(count, sizeof(count), "%d %s", (int)list.size(),
                     e.group == GROUP_TAGS ? (list.size() == 1 ? "tag" : "tags") : (list.size() == 1 ? "author" : "authors"));
            lines.push_back(count);
            lines.push_back("");
            for (size_t i = 0; i < list.size() && i < 8; ++i)
                lines.push_back(fit(folders[list[i]].label, 40));
            if (list.empty())
                lines.push_back(e.group == GROUP_TAGS ? "Add tags to games in the PC app." : "Add authors to games in the PC app.");
            drawTopText(s, e.label.c_str(), lines);
        }
    } else { // VIEW_SUB
        auto &list = groupFolders(subGroup);
        if (subList.cursor < (int)list.size())
            drawTopFolder(s, folders[list[subList.cursor]].label, folders[list[subList.cursor]].items);
    }
}

static void drawHeader(Screen &s, const std::string &title, bool canGoBack) {
    fillRect(s, 0, 0, s.w, HEADER_H, colHighlight);
    std::string t = fit(title, 34);
    drawText(s, (s.w - (int)t.size() * 8) / 2, 7, t.c_str(), colText);
    if (canGoBack)
        drawText(s, 8, 7, "<", colText);
}

static void drawScrollBar(Screen &s, int top, int rows, int rowH, const ListState &l, int count) {
    if (count <= rows)
        return;
    int track = rows * rowH;
    int len = std::max(8, track * rows / count);
    int pos = (track - len) * l.scroll / (count - rows);
    fillRect(s, s.w - 6, top, 2, track, colHighlight);
    fillRect(s, s.w - 6, top + pos, 2, len, colDim);
}

// A list of folders: name on the left, number of games on the right.
static void drawFolderRows(Screen &s, const std::vector<std::pair<std::string, int>> &rows, const ListState &l,
                           int visible, bool cursorShown) {
    for (int r = 0; r < visible && l.scroll + r < (int)rows.size(); ++r) {
        int idx = l.scroll + r, y = MENU_TOP + r * MENU_ROW_H;
        bool sel = cursorShown && idx == l.cursor;
        if (sel)
            fillRect(s, 4, y, s.w - 14, MENU_ROW_H - 2, colHighlight);
        drawText(s, 14, y + 8, fit(rows[idx].first, 28).c_str(), sel ? colText : colDim);
        if (rows[idx].second >= 0) {
            char n[16];
            snprintf(n, sizeof(n), "%d", rows[idx].second);
            drawText(s, s.w - 20 - (int)strlen(n) * 8, y + 8, n, sel ? colText : colDim);
        } else {
            drawText(s, s.w - 28, y + 8, ">", sel ? colText : colDim);
        }
    }
    drawScrollBar(s, MENU_TOP, visible, MENU_ROW_H, l, rows.size());
}

static void drawBottom() {
    Screen s = beginScreen(GFX_BOTTOM);
    fillRect(s, 0, 0, s.w, 240, colBackground);

    if (view == VIEW_MENU) {
        drawHeader(s, APP_NAME, false);
        std::vector<std::pair<std::string, int>> rows;
        for (auto &e : menu)
            rows.push_back({e.label, e.folder >= 0 ? (int)folders[e.folder].items.size() : -1});
        drawFolderRows(s, rows, menuList, MENU_ROWS, true);
        // The button.
        bool sel = buttonSelected();
        fillRect(s, 20, BUTTON_Y, s.w - 40, BUTTON_H, sel ? colAccent : colHighlight);
        const char *label = "Get games from PC";
        drawText(s, (s.w - (int)strlen(label) * 8) / 2, BUTTON_Y + 9, label, sel ? colBackground : colText);
        drawText(s, 6, 226, "A:open  START:close", colDim);
        return;
    }

    if (view == VIEW_SUB) {
        drawHeader(s, subGroup == GROUP_TAGS ? "Tags" : "Authors", true);
        auto &list = groupFolders(subGroup);
        std::vector<std::pair<std::string, int>> rows;
        for (int f : list)
            rows.push_back({folders[f].label, (int)folders[f].items.size()});
        if (rows.empty()) {
            const char *msg = subGroup == GROUP_TAGS ? "No tags yet" : "No authors yet";
            drawText(s, (s.w - (int)strlen(msg) * 8) / 2, 100, msg, colDim);
            const char *hint = "Add them to games in the PC app.";
            drawText(s, (s.w - (int)strlen(hint) * 8) / 2, 116, hint, colDim);
        }
        drawFolderRows(s, rows, subList, SUB_ROWS, true);
        drawText(s, 6, 226, "A:open  B:back", colDim);
        return;
    }

    // VIEW_GAMES
    drawHeader(s, folder().title, true);
    auto &items = folder().items;
    if (items.empty()) {
        const char *msg = games.empty() ? "No games installed yet" : "No games here yet";
        drawText(s, (s.w - (int)strlen(msg) * 8) / 2, 110, msg, colDim);
    }
    for (int row = 0; row < GAME_ROWS && gameList.scroll + row < (int)items.size(); ++row) {
        int idx = gameList.scroll + row, y = GAME_TOP + row * GAME_ROW_H;
        const Game &g = games[items[idx]];
        if (idx == gameList.cursor)
            fillRect(s, 4, y, s.w - 14, GAME_ROW_H, colHighlight);
        drawText(s, 12, y + 4, fit(g.name, 34).c_str(), idx == gameList.cursor ? colText : colDim);
        if (g.favourite)
            drawText(s, s.w - 24, y + 4, "*", colAccent);
    }
    drawScrollBar(s, GAME_TOP, GAME_ROWS, GAME_ROW_H, gameList, items.size());
    drawText(s, 6, 226, "A:play  Y:favourite  B:back", colDim);
}

// Opens a folder's game list, on the last game played if it is in there.
static void openFolder(int f, View from) {
    folderIndex = f;
    gamesBack = from;
    gameList = ListState();
    auto &items = folder().items;
    for (int i = 0; i < (int)items.size(); ++i)
        if (games[items[i]].id == lastGameId)
            gameList.cursor = i;
    gameList.scroll = gameList.cursor - GAME_ROWS / 2;
    keepVisible(gameList, items.size(), GAME_ROWS);
    view = VIEW_GAMES;
}

// ---- getting games from the PC ---------------------------------------------------

// Shows sync progress on the bottom screen; false once B is pressed.
static bool syncStatus(const char *line1, const char *line2) {
    if (!aptMainLoop())
        return false;
    hidScanInput();
    if (hidKeysDown() & KEY_B)
        return false;
    Screen s = beginScreen(GFX_BOTTOM);
    fillRect(s, 0, 0, s.w, 240, colBackground);
    drawHeader(s, "Games from PC", false);
    auto a = wrap(line1, 38), b = wrap(line2, 38);
    int y = 90;
    for (auto &l : a) {
        drawText(s, 8, y, l.c_str(), colText);
        y += 12;
    }
    y += 8;
    for (auto &l : b) {
        drawText(s, 8, y, l.c_str(), colDim);
        y += 12;
    }
    gfxFlushBuffers();
    gfxSwapBuffers();
    gspWaitForVBlank();
    return true;
}

static void getGamesFromPC() {
    if (syncFromPC(syncStatus) > 0) {
        games.clear();
        scanGames();
        buildFolders();
        buildMenu();
        artGame = -2;
    }
    // Wait for B to be let go, so it does not also count as "back".
    do {
        hidScanInput();
        gspWaitForVBlank();
    } while (hidKeysHeld() & KEY_B);
}

// ---- launching ----------------------------------------------------------------------------

static std::string selfPath;

static void launch(int gi) {
    Game &g = games[gi];
    g.plays++;
    g.lastPlayed = time(NULL);
    lastGameId = g.id;
    saveStats();

    std::string path = gameDir(g) + "/game.3dsx";
    std::string libArg = "--library=" + selfPath;
    const char *args[] = {path.c_str(), libArg.c_str()};
    if (!hbldr_set_next(path.c_str(), 2, args))
        return; // no loader: stay in the library

    for (int i = 0; i < 2; ++i) { // both buffers
        Screen s = beginScreen(GFX_BOTTOM);
        fillRect(s, 0, 0, s.w, 240, colBackground);
        std::string msg = "Starting " + fit(g.name, 28) + "...";
        drawText(s, (s.w - (int)msg.size() * 8) / 2, 112, msg.c_str(), colText);
        gfxFlushBuffers();
        gfxSwapBuffers();
        gspWaitForVBlank();
    }
    gfxExit();
    exit(0);
}

// ---- start-up notice --------------------------------------------------------------------

// Shown when the library is started (not when coming back from a game):
// press A or tap the screen to continue.
static void showDisclaimer() {
    const char *lines[] = {
        "Makecode Arcade on 3ds is an",
        "unofficial fan project.",
        "",
        "It is NOT made by, affiliated with,",
        "or endorsed by Microsoft or",
        "Microsoft MakeCode.",
        "",
        "MakeCode and Microsoft are",
        "trademarks of Microsoft Corporation.",
    };
    while (aptMainLoop()) {
        hidScanInput();
        u32 down = hidKeysDown();
        if (down & (KEY_A | KEY_TOUCH))
            break;
        Screen top = beginScreen(GFX_TOP);
        fillRect(top, 0, 0, top.w, 240, colBackground);
        drawText(top, (top.w - (int)strlen(APP_NAME) * 16) / 2, 96, APP_NAME, colText, 2);
        drawText(top, (top.w - 15 * 8) / 2, 128, "Unofficial app", colAccent);

        Screen s = beginScreen(GFX_BOTTOM);
        fillRect(s, 0, 0, s.w, 240, colBackground);
        fillRect(s, 0, 0, s.w, 22, colHighlight);
        drawText(s, (s.w - 6 * 8) / 2, 7, "Notice", colText);
        int y = 44;
        for (const char *l : lines) {
            drawText(s, 16, y, l, colText);
            y += 14;
        }
        fillRect(s, 20, 190, s.w - 40, 26, colAccent);
        const char *ok = "A / tap: I understand";
        drawText(s, (s.w - (int)strlen(ok) * 8) / 2, 199, ok, colBackground);
        gfxFlushBuffers();
        gfxSwapBuffers();
        gspWaitForVBlank();
    }
    // Wait for the button / finger to be let go, so it does not also choose something.
    do {
        hidScanInput();
        gspWaitForVBlank();
    } while (hidKeysHeld() & (KEY_A | KEY_TOUCH));
}

// ---- main ---------------------------------------------------------------------------------

int main(int argc, char **argv) {
    gfxInitDefault();
    acInit(); // Wi-Fi status, for getting games from the PC
    // Draw straight into the framebuffers in 24-bit colour, double buffered.
    gfxSetScreenFormat(GFX_TOP, GSP_BGR8_OES);
    gfxSetScreenFormat(GFX_BOTTOM, GSP_BGR8_OES);
    gfxSetDoubleBuffering(GFX_TOP, true);
    gfxSetDoubleBuffering(GFX_BOTTOM, true);

    selfPath = (argc > 0 && !strncmp(argv[0], "sdmc:/", 6)) ? argv[0] : LIB_DIR "/library.3dsx";

    mkdir("sdmc:/3ds", 0777);
    mkdir(LIB_DIR, 0777);
    mkdir(LIB_DIR "/games", 0777);
    loadTheme();
    havePlaceholder = loadArt(LIB_DIR "/placeholder.art", placeholderArt);
    scanGames();
    buildFolders();
    buildMenu();

    bool fromGame = false;
    for (int i = 1; i < argc; ++i)
        if (!strcmp(argv[i], "--from-game"))
            fromGame = true;
    if (!fromGame)
        showDisclaimer();

    hidSetRepeatParameters(18, 5);

    while (aptMainLoop()) {
        hidScanInput();
        u32 down = hidKeysDown(), repeat = hidKeysDownRepeat(), held = hidKeysHeld();
        touchPosition t = {0, 0};
        if (held & KEY_TOUCH)
            hidTouchRead(&t);
        bool tapBack = (down & KEY_TOUCH) && t.py < HEADER_H && t.px < 48;

        if (down & KEY_START)
            break;

        if (view == VIEW_MENU) {
            int count = menu.size() + 1; // + the button
            int before = menuList.cursor;
            if (repeat & (KEY_DUP | KEY_CPAD_UP))
                menuList.cursor = (menuList.cursor + count - 1) % count;
            if (repeat & (KEY_DDOWN | KEY_CPAD_DOWN))
                menuList.cursor = (menuList.cursor + 1) % count;
            if (menuList.cursor != before && menuList.cursor < (int)menu.size())
                keepVisible(menuList, menu.size(), MENU_ROWS);

            bool choose = down & KEY_A;
            // The button can be tapped directly.
            if ((down & KEY_TOUCH) && t.py >= BUTTON_Y && t.py < BUTTON_Y + BUTTON_H) {
                menuList.cursor = menu.size();
                choose = true;
            } else if (!(held & KEY_TOUCH) || t.py < BUTTON_Y) {
                ListState rows = menuList;
                if (rows.cursor >= (int)menu.size())
                    rows.cursor = -1;
                int chosen = touchList(rows, menu.size(), MENU_TOP, MENU_ROW_H, MENU_ROWS, held, t);
                if (rows.cursor >= 0)
                    menuList.cursor = rows.cursor;
                menuList.scroll = rows.scroll;
                if (chosen >= 0)
                    choose = true;
            }
            if (choose) {
                if (buttonSelected()) {
                    getGamesFromPC();
                } else {
                    const MenuEntry &e = menu[menuList.cursor];
                    if (e.folder >= 0) {
                        openFolder(e.folder, VIEW_MENU);
                    } else {
                        subGroup = e.group;
                        subList = ListState();
                        view = VIEW_SUB;
                    }
                }
            }
        } else if (view == VIEW_SUB) {
            auto &list = groupFolders(subGroup);
            moveWithButtons(subList, list.size(), SUB_ROWS, repeat);
            int chosen = touchList(subList, list.size(), MENU_TOP, MENU_ROW_H, SUB_ROWS, held, t);
            if ((down & KEY_A) && subList.cursor < (int)list.size())
                chosen = subList.cursor;
            if (chosen >= 0 && chosen < (int)list.size())
                openFolder(list[chosen], VIEW_SUB);
            else if ((down & KEY_B) || tapBack)
                view = VIEW_MENU;
        } else { // VIEW_GAMES
            int n = folder().items.size();
            moveWithButtons(gameList, n, GAME_ROWS, repeat);
            int chosen = touchList(gameList, n, GAME_TOP, GAME_ROW_H, GAME_ROWS, held, t);
            if ((down & KEY_A) && selectedGame() >= 0)
                chosen = gameList.cursor;
            if (chosen >= 0 && chosen < n)
                launch(folder().items[chosen]);
            if ((down & KEY_Y) && selectedGame() >= 0) {
                int gi = selectedGame();
                games[gi].favourite = !games[gi].favourite;
                saveStats();
                buildFolders(); // the folder list keeps the same order
                buildMenu();
                gameList.cursor = 0;
                for (int i = 0; i < (int)folder().items.size(); ++i)
                    if (folder().items[i] == gi)
                        gameList.cursor = i;
                keepVisible(gameList, folder().items.size(), GAME_ROWS);
            }
            if ((down & KEY_B) || tapBack)
                view = gamesBack;
        }

        // Both screens are drawn in full every frame. (Drawing only when
        // something changed left leftovers from the previous program on screen.)
        drawTop();
        drawBottom();
        gfxFlushBuffers();
        gfxSwapBuffers();
        gspWaitForVBlank();
    }

    acExit();
    gfxExit();
    return 0;
}
