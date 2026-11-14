#!/usr/bin/env node
// build-cia.js
// Builds "Makecode Arcade on 3ds.cia": the HOME-menu title that opens the
// library. Install it once with FBI (or another title installer); after that,
// adding or changing games is just copying the makecode-arcade folder again.
//
// Uses (all in library/):
//   icon.png     48x48 HOME-menu icon
//   banner.png   256x128 banner shown on the top screen when the icon is picked
//   banner.wav   startup sound (about 3 seconds at most)
//   app.rsf      title settings
//   forwarder/   the small program inside the .cia (see its main.cpp)
// Make icon/banner/sound from your art with tools/make-app-art.js.
//
// Needs tools/bin/makerom and tools/bin/bannertool (downloaded already).
//
// Usage:  node tools/build-cia.js

const fs = require("fs");
const path = require("path");
const { run, fail, bin, ctru, root } = require("./player-build.js");

const libDir = path.join(root, "library");
const buildDir = path.join(libDir, "build", "cia");
fs.mkdirSync(buildDir, { recursive: true });

const makerom = path.join(root, "tools", "bin", "makerom", "makerom.exe");
const bannertool = path.join(root, "tools", "bin", "bannertool", "windows-x86_64", "bannertool.exe");
for (const t of [makerom, bannertool]) if (!fs.existsSync(t)) fail(`${t} is missing.`);
for (const f of ["icon.png", "banner.png", "app.rsf"])
    if (!fs.existsSync(path.join(libDir, f))) fail(`library/${f} is missing (see tools/make-app-art.js).`);

const TITLE = "Makecode Arcade on 3ds";
const DESCRIPTION = "Play your MakeCode Arcade games";
const PUBLISHER = "MakeCode 3DS";

// ---- 1. The starter program ----------------------------------------------------

const ARCH = ["-march=armv6k", "-mtune=mpcore", "-mfloat-abi=hard", "-mtp=soft"];
const flags = [...ARCH, "-O2", "-g", "-std=gnu++14", "-fno-rtti", "-fno-exceptions", "-D__3DS__",
    "-I" + path.join(root, "player", "source", "include"), "-I" + path.join(ctru, "include")];
const objects = [];
for (const src of [path.join(libDir, "forwarder", "main.cpp"), path.join(root, "player", "source", "hbldr.cpp")]) {
    const obj = path.join(buildDir, path.basename(src, ".cpp") + ".o");
    run(bin("g++"), [...flags, "-c", src, "-o", obj]);
    objects.push(obj);
}
const elf = path.join(buildDir, "forwarder.elf");
run(bin("g++"), ["-specs=3dsx.specs", "-g", ...ARCH, ...objects, "-L" + path.join(ctru, "lib"), "-lctru", "-lm", "-o", elf]);

// ---- 2. Icon and banner ------------------------------------------------------------

const icn = path.join(buildDir, "icon.icn");
run(bannertool, ["makesmdh", "-s", TITLE, "-l", DESCRIPTION, "-p", PUBLISHER, "-i", path.join(libDir, "icon.png"), "-o", icn]);
const bnr = path.join(buildDir, "banner.bnr");
const sound = path.join(libDir, "banner.wav");
const bannerArgs = ["makebanner", "-i", path.join(libDir, "banner.png"), "-o", bnr];
if (fs.existsSync(sound)) bannerArgs.push("-a", sound);
else console.log("No library/banner.wav: the banner will be silent.");
run(bannertool, bannerArgs);

// ---- 3. The .cia ----------------------------------------------------------------------

const outDir = path.join(root, "built 3ds games");
fs.mkdirSync(outDir, { recursive: true });
const cia = path.join(outDir, TITLE + ".cia");
run(makerom, ["-f", "cia", "-o", cia, "-rsf", path.join(libDir, "app.rsf"), "-target", "t", "-exefslogo",
    "-elf", elf, "-icon", icn, "-banner", bnr,
    "-DAPP_TITLE=" + TITLE,
    "-DAPP_PRODUCT_CODE=CTR-H-MCA3",
    "-DAPP_UNIQUE_ID=0xF3DA1", // homebrew titles use 0xF0000-0xFFFFF
    "-DAPP_CATEGORY=Application",
    "-DAPP_USE_ON_SD=true",
    "-DAPP_ENCRYPTED=false",
    "-DAPP_MEMORY_TYPE=Application",
    "-DAPP_SYSTEM_MODE=64MB",
    "-DAPP_SYSTEM_MODE_EXT=Legacy",
    "-DAPP_CPU_SPEED=268MHz",
    "-DAPP_ENABLE_L2_CACHE=false",
]);

const size = fs.statSync(cia).size;
console.log(`\nDone: ${cia} (${(size / 1024).toFixed(0)} KB)`);
console.log("Install it with FBI. It opens the library in sdmc:/3ds/makecode-arcade/, so copy");
console.log("the makecode-arcade folder to the SD card too (node tools/build-library.js makes it).");
