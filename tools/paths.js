// paths.js
// Where things live, in one place.
//
//   tools/             these scripts
//   player/            the 3DS runtime (MakeCode's C++ runtime + the 3DS side)
//   library/           the 3DS library app, its art and settings
//   games/             one folder per game (MakeCode projects), plus
//   games/_deps/       the GitHub extensions those games use
//   built 3ds games/   finished .3dsx files, and makecode-arcade/ for the SD card

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const gamesDir = path.join(root, "games");
const depsDir = path.join(gamesDir, "_deps");

// The game folders (names), alphabetically.
function gameFolders() {
    if (!fs.existsSync(gamesDir)) return [];
    return fs.readdirSync(gamesDir).filter(d => !d.startsWith("_") &&
        fs.existsSync(path.join(gamesDir, d, "pxt.json")) && fs.existsSync(path.join(gamesDir, d, "main.ts"))).sort();
}

// A game given on the command line: a path, or just its folder name in games/.
function resolveGame(arg) {
    if (!arg) return null;
    const direct = path.resolve(arg);
    if (fs.existsSync(path.join(direct, "pxt.json"))) return direct;
    const named = path.join(gamesDir, arg);
    if (fs.existsSync(path.join(named, "pxt.json"))) return named;
    return direct; // let the caller report it
}

module.exports = { root, gamesDir, depsDir, gameFolders, resolveGame };
