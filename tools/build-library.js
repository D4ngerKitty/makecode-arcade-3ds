#!/usr/bin/env node
// build-library.js
// Builds the library app and brings its SD-card folder up to date:
//
//   built 3ds games/makecode-arcade/      -> copy into the 3ds folder on the SD card
//     library.3dsx        the library app (start it from the Homebrew Launcher)
//     theme.cfg           colours (from library/theme.cfg)
//     placeholder.art     art for games without any (from library/placeholder.png)
//     games/<game>/...    every game that has been built (see library-install.js)
//
// Usage:  node tools/build-library.js

const fs = require("fs");
const path = require("path");
const { run, fail, bin, tool, ctru, root } = require("./player-build.js");
const { installGame, libraryOut } = require("./library-install.js");
const { pngToArt } = require("./png.js");

const libDir = path.join(root, "library");
const buildDir = path.join(libDir, "build");
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(libraryOut, { recursive: true });

// ---- 1. Compile and link the app ----------------------------------------------

const ARCH = ["-march=armv6k", "-mtune=mpcore", "-mfloat-abi=hard", "-mtp=soft"];
const flags = [...ARCH, "-O2", "-g", "-std=gnu++14", "-fno-rtti", "-fno-exceptions", "-ffunction-sections",
    "-D__3DS__", "-I" + path.join(libDir, "source"), "-I" + path.join(root, "player", "source", "include"), "-I" + path.join(ctru, "include")];
const sources = [path.join(libDir, "source", "main.cpp"), path.join(libDir, "source", "sync.cpp"),
    path.join(root, "player", "source", "hbldr.cpp")];
const objects = [];
for (const src of sources) {
    const obj = path.join(buildDir, path.basename(src, ".cpp") + ".o");
    console.log("Compiling " + path.relative(root, src));
    run(bin("g++"), [...flags, "-c", src, "-o", obj]);
    objects.push(obj);
}
const elf = path.join(buildDir, "library.elf");
run(bin("g++"), ["-specs=3dsx.specs", "-g", ...ARCH, "-Wl,--gc-sections", ...objects,
    "-L" + path.join(ctru, "lib"), "-lctru", "-lm", "-o", elf]);

// Package as .3dsx with its title and icon (this project's own writers).
const smdh = require("./smdh.js").makeSmdh({
    title: "Makecode Arcade on 3ds",
    description: "Play your MakeCode Arcade games",
    publisher: "MakeCode 3DS",
    icon: path.join(libDir, "icon.png"),
});
fs.writeFileSync(path.join(libraryOut, "library.3dsx"), require("./3dsx.js").elfTo3dsx(fs.readFileSync(elf), smdh));

// ---- 2. Theme and placeholder art ------------------------------------------------

fs.copyFileSync(path.join(libDir, "theme.cfg"), path.join(libraryOut, "theme.cfg"));
const placeholder = path.join(libDir, "placeholder.png");
if (fs.existsSync(placeholder)) pngToArt(placeholder, path.join(libraryOut, "placeholder.art"));
else console.log("No library/placeholder.png yet: games without art show a \"?\".");

// ---- 3. Every built game ------------------------------------------------------------

let count = 0;
const { gamesDir, gameFolders } = require("./paths.js");
for (const d of gameFolders()) {
    const projectDir = path.join(gamesDir, d);
    const built = path.join(projectDir, "built", "3ds", d + ".3dsx");
    if (!fs.existsSync(built)) continue;
    try {
        installGame(projectDir, built);
        count++;
    } catch (e) {
        console.log(`Skipped ${d}: ${e.message}`);
    }
}

console.log(`\nLibrary ready with ${count} games: ${libraryOut}`);
console.log("Copy the makecode-arcade folder into the 3ds folder on your SD card,");
console.log("then start \"Makecode Arcade on 3ds\" from the Homebrew Launcher.");
