// library-install.js
// Puts a built game into the library's folder, which mirrors what goes on the
// SD card:  "built 3ds games/makecode-arcade/"  ->  sdmc:/3ds/makecode-arcade/
//
//   games/<game folder>/game.3dsx   the game
//   games/<game folder>/info.txt    its details, from <game folder>/library.json
//   games/<game folder>/art.art     its art, from <game folder>/art.png (optional)
//
// library.json is created the first time with what the project already says
// (name, description, version); fill in author and tags yourself, then
// rebuild (or run node tools/build-library.js) to update the library.
// Tags are a list of words that describe the game ("platformer", "boss
// fights", ...); each tag becomes a folder in the library.

const fs = require("fs");
const path = require("path");
const { pngToArt } = require("./png.js");

const root = path.resolve(__dirname, "..");
const libraryOut = path.join(root, "built 3ds games", "makecode-arcade");

// The 3DS font only has plain characters: swap common fancy ones, drop the rest.
function plain(text) {
    return String(text || "")
        .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
        .replace(/…/g, "...").replace(/\r?\n/g, "\\n")
        .replace(/[^\x20-\x7e\\]/g, "").trim();
}

const HELP = "Shown in the 3DS library. tags is a list like [\"platformer\", \"boss fights\"]; " +
    "each tag becomes a folder. Put pixel art for the game in art.png next to this file (square works best). " +
    "Rebuild after editing.";

// Reads (creating if needed) <game folder>/library.json.
function readLibraryJson(projectDir) {
    const file = path.join(projectDir, "library.json");
    if (!fs.existsSync(file)) {
        const pxt = JSON.parse(fs.readFileSync(path.join(projectDir, "pxt.json"), "utf8"));
        const fresh = {
            "_help": HELP,
            name: pxt.name || path.basename(projectDir),
            author: "",
            version: pxt.version || "",
            tags: [],
            description: pxt.description || "",
        };
        fs.writeFileSync(file, JSON.stringify(fresh, null, 4) + "\n");
        console.log(`Wrote ${file}: add the author and tags there.`);
    }
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    // Files from before tags existed have a single "genre": turn it into tags.
    if (info.genre !== undefined && info.tags === undefined) {
        const out = {};
        for (const [k, v] of Object.entries(info)) {
            if (k === "genre") out.tags = String(v).split(",").map(t => t.trim()).filter(t => t);
            else out[k] = k === "_help" ? HELP : v;
        }
        fs.writeFileSync(file, JSON.stringify(out, null, 4) + "\n");
        return out;
    }
    return info;
}

function installGame(projectDir, built3dsx) {
    const id = path.basename(projectDir);
    const dir = path.join(libraryOut, "games", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(built3dsx, path.join(dir, "game.3dsx"));

    const info = readLibraryJson(projectDir);
    const tags = [].concat(info.tags || []).map(t => plain(t).replace(/,/g, " ")).filter(t => t);
    // Several authors: a list in library.json, or "Ann, Bob" / "Ann & Bob".
    const author = [].concat(info.author || []).join(", ");
    const lines = [`name=${plain(info.name)}`, `author=${plain(author)}`, `version=${plain(info.version)}`];
    lines.push(`tags=${tags.join(",")}`, `description=${plain(info.description)}`);
    fs.writeFileSync(path.join(dir, "info.txt"), lines.join("\n") + "\n");

    // Art: <game folder>/art.png, or <game folder>.png in the "game art" folder.
    let png = path.join(projectDir, "art.png");
    const dropped = path.join(root, "game art", id + ".png");
    if (!fs.existsSync(png) && fs.existsSync(dropped)) png = dropped;
    const art = path.join(dir, "art.art");
    if (fs.existsSync(png)) {
        const img = pngToArt(png, art);
        if (img.width !== img.height) console.log(`Note: ${png} is ${img.width}x${img.height}; square art fills the box best.`);
    } else {
        fs.rmSync(art, { force: true });
    }
    return dir;
}

module.exports = { installGame, libraryOut };
