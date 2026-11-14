#!/usr/bin/env node
// add-art.js
// Gives a game its picture in the library.
//
//   node tools/add-art.js <game folder> <picture.png>
//       use your own picture (pixel art; square works best)
//
//   node tools/add-art.js <game folder> --screenshot [frame]
//       take one from the game itself: runs it in the PC emulator up to that
//       frame (default 300, about 5 seconds in) and keeps the middle square
//
//   node tools/add-art.js --list
//       show which games have a picture
//
// The picture is saved as <game folder>/art.png and the game's entry in
// "built 3ds games/makecode-arcade" is updated straight away, so just copy
// that folder to the SD card again. (Dropping <game folder>.png into the
// "game art" folder and running node tools/build-library.js works too.)

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { readPng, writePng, trueSize } = require("./png.js");
const { installGame } = require("./library-install.js");

const root = path.resolve(__dirname, "..");
const artFolder = path.join(root, "game art");

function fail(msg) {
    console.error("ERROR: " + msg);
    process.exit(1);
}

const { gamesDir, gameFolders, resolveGame } = require("./paths.js");

const args = process.argv.slice(2);

if (args[0] === "--list" || !args.length) {
    if (!args.length) console.log("Usage: node tools/add-art.js <game folder> <picture.png | --screenshot [frame]>\n");
    for (const g of gameFolders()) {
        const own = fs.existsSync(path.join(gamesDir, g, "art.png"));
        const dropped = fs.existsSync(path.join(artFolder, g + ".png"));
        console.log(`  ${own || dropped ? "has art " : "no art  "}  ${g}`);
    }
    process.exit(0);
}

const projectDir = resolveGame(args[0]);
if (!fs.existsSync(path.join(projectDir, "pxt.json"))) fail(`${args[0]} is not a game folder.`);
const target = path.join(projectDir, "art.png");

if (args[1] === "--screenshot") {
    const frame = String(Number(args[2]) || 300);
    console.log(`Running the game to frame ${frame} in the PC emulator...`);
    const r = spawnSync(process.execPath, [path.join(__dirname, "test-qemu.js"), projectDir, "--frames", frame],
        { encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true });
    const shot = path.join(projectDir, "built", "qemu", `frame_${frame.padStart(5, "0")}.png`);
    if (!fs.existsSync(shot)) {
        process.stdout.write((r.stdout || "") + (r.stderr || ""));
        fail("The emulator did not produce a screenshot (has the game been built?).");
    }
    // Screenshots are saved at 2x; go back to the game's own pixels, then
    // keep the middle square.
    const img = trueSize(readPng(shot));
    const size = Math.min(img.width, img.height);
    const x0 = Math.floor((img.width - size) / 2), y0 = Math.floor((img.height - size) / 2);
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++)
        img.rgba.copy(rgba, y * size * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + size) * 4);
    writePng(target, { width: size, height: size, rgba });
    console.log(`Saved a ${size}x${size} picture from frame ${frame}. Try another frame if it is not a good one.`);
} else if (args[1]) {
    const picture = path.resolve(args[1]);
    if (!fs.existsSync(picture)) fail(`${args[1]} not found.`);
    const img = readPng(picture); // checks it is a PNG we can read
    if (path.resolve(picture) !== target) fs.copyFileSync(picture, target);
    const t = trueSize(img);
    console.log(`Saved ${t.width}x${t.height} art` + (t.width !== img.width ? ` (your ${img.width}x${img.height} picture is enlarged pixel art)` : "") + ".");
    if (t.width !== t.height) console.log("Note: it is not square, so it will have empty space beside it.");
} else {
    fail("Give a picture (a .png file) or --screenshot.");
}

// Update the game's entry in the library folder now.
const built = path.join(projectDir, "built", "3ds", path.basename(projectDir) + ".3dsx");
if (fs.existsSync(built)) {
    installGame(projectDir, built);
    console.log(`Library updated. Copy "built 3ds games/makecode-arcade" to the SD card again.`);
} else {
    console.log("The game is not built yet; the art will be used when it is.");
}
