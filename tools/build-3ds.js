#!/usr/bin/env node
// build-3ds.js
// Links a game built by get-game.js with the 3DS runtime (player/) and
// produces a .3dsx you can run from the Homebrew Launcher.
//
// Usage:  node tools/build-3ds.js <project folder>
// Output: "built 3ds games/<name>.3dsx" (all games together), and a copy in
//         <project>/built/3ds/ next to the build's working files.
//
// Needs devkitPro with the 3DS tools (devkitARM, libctru, 3dstools).

const fs = require("fs");
const path = require("path");
const { buildPlayer, fail, root } = require("./player-build.js");

if (!process.argv[2]) fail("Usage: node tools/build-3ds.js <project folder>");
const projectDir = require("./paths.js").resolveGame(process.argv[2]);
const outBase = buildPlayer(projectDir, "3ds");

// Package it as a .3dsx with its title and icon, using this project's own
// writers (tools/smdh.js, tools/3dsx.js) rather than devkitPro's smdhtool and
// 3dsxtool. (tools/check-3dsx.js checks they produce the same files.)
const { makeSmdh } = require("./smdh.js");
const { elfTo3dsx } = require("./3dsx.js");
const pxtJson = JSON.parse(fs.readFileSync(path.join(projectDir, "pxt.json"), "utf8"));
const title = pxtJson.name || path.basename(projectDir);
const smdh = makeSmdh({
    title: title.slice(0, 64),
    description: "MakeCode Arcade game",
    publisher: "MakeCode 3DS Player",
    icon: path.join(root, "library", "icon.png"),
});
fs.writeFileSync(outBase + ".smdh", smdh);
fs.writeFileSync(outBase + ".3dsx", elfTo3dsx(fs.readFileSync(outBase + ".elf"), smdh));

// Every finished game is also copied into one folder, ready to go on the SD card.
const gamesDir = path.join(root, "built 3ds games");
fs.mkdirSync(gamesDir, { recursive: true });
const finalPath = path.join(gamesDir, path.basename(projectDir) + ".3dsx");
fs.copyFileSync(outBase + ".3dsx", finalPath);

// ...and into the library's folder (see library-install.js).
require("./library-install.js").installGame(projectDir, outBase + ".3dsx");

const size = fs.statSync(finalPath).size;
console.log(`\nDone: ${finalPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log("Copy it to the 3ds folder on your SD card, or send it with 3dslink.");
