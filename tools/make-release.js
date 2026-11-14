#!/usr/bin/env node
// make-release.js
// Makes the downloadable version: release/MakeCode 3DS/ (and a .zip of it),
// with MakeCode 3DS.exe and only what a new user needs - no games.
//
// Usage:  node tools/make-release.js
//
// The .exe is a Node.js "single executable application": Node itself with
// tools/launcher/main.js built in. The 3DS build tools come along in
// the toolchain/ folder (tools/make-toolchain.js) means they need nothing else.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
// --out <folder>: build somewhere else (for testing) instead of release/.
const outArg = process.argv.indexOf("--out");
const releaseDir = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, "release");
const outDir = path.join(releaseDir, "MakeCode 3DS");

function fail(msg) {
    console.error("ERROR: " + msg);
    process.exit(1);
}

function copy(rel, filter = () => true) {
    const src = path.join(root, rel), dst = path.join(outDir, rel);
    if (!fs.existsSync(src)) fail(`${rel} is missing`);
    fs.cpSync(src, dst, { recursive: true, filter: s => filter(path.relative(root, s).split(path.sep).join("/")) });
}

try {
    fs.rmSync(releaseDir, { recursive: true, force: true });
} catch (e) {
    fail(`could not replace ${releaseDir} (${e.code}). Close MakeCode 3DS if it is running from there, then try again.`);
}
fs.mkdirSync(outDir, { recursive: true });

// ---- 1. The app and tools -----------------------------------------------------------
console.log("Copying the app and tools...");
copy("tools", p => !/^tools\/(bin|3ds-libs)(\/|$)/.test(p) && !/_tmp\.js$/.test(p));
copy("player", p => !/^player\/build(\/|$)/.test(p));
copy("library", p => !/^library\/(build)(\/|$)/.test(p) && !/banner-source\.wav$/.test(p));
for (const f of ["README.md", "DEVELOPING.md", "THIRD-PARTY-NOTICES.md", "LICENSE"])
    if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(outDir, f));

// An empty games folder (where the app keeps the user's games).
fs.mkdirSync(path.join(outDir, "games"), { recursive: true });

// The finished library folder for the SD card, with no games yet.
const lib = path.join(root, "built 3ds games", "makecode-arcade");
const libOut = path.join(outDir, "built 3ds games", "makecode-arcade");
fs.mkdirSync(path.join(libOut, "games"), { recursive: true });
for (const f of ["library.3dsx", "theme.cfg", "placeholder.art"])
    if (fs.existsSync(path.join(lib, f))) fs.copyFileSync(path.join(lib, f), path.join(libOut, f));
const cia = path.join(root, "built 3ds games", "Makecode Arcade on 3ds.cia");
if (fs.existsSync(cia)) fs.copyFileSync(cia, path.join(outDir, "built 3ds games", path.basename(cia)));

// The bundled 3DS toolchain, so users need no devkitPro (tools/make-toolchain.js).
if (!fs.existsSync(path.join(root, "toolchain", "runtime", "runtime.json"))) {
    console.log("Making the toolchain folder...");
    const t = spawnSync(process.execPath, [path.join(__dirname, "make-toolchain.js")], { stdio: "inherit" });
    if (t.status !== 0) fail("making the toolchain folder failed");
}
copy("toolchain");

// ---- 2. MakeCode's compiler (the "makecode" npm package) ---------------------------
console.log("Copying the MakeCode compiler...");
const npmRoot = spawnSync("npm root -g", { encoding: "utf8", shell: true }).stdout.trim();
const mkcSrc = path.join(npmRoot, "makecode");
if (!fs.existsSync(path.join(mkcSrc, "makecode"))) fail("the makecode package is not installed (npm install -g makecode)");
fs.cpSync(mkcSrc, path.join(outDir, "mkc", "makecode"), { recursive: true });

// ---- 3. The .exe ------------------------------------------------------------------------
console.log("Building MakeCode 3DS.exe...");
const exe = path.join(outDir, "MakeCode 3DS.exe");
const seaConfig = path.join(os.tmpdir(), "mca3ds-sea.json");
fs.writeFileSync(seaConfig, JSON.stringify({
    main: path.join(__dirname, "launcher", "main.js"),
    output: exe,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
}));
// Built from a stable (LTS) Node.js in tools/bin/node-lts/ when there is one
// (download the Windows .zip from nodejs.org and unpack it there), otherwise
// from the Node.js running this script.
const ltsDir = path.join(root, "tools", "bin", "node-lts");
const ltsNode = fs.existsSync(ltsDir) && fs.readdirSync(ltsDir).map(d => path.join(ltsDir, d, "node.exe")).find(f => fs.existsSync(f));
const exeNode = ltsNode || process.execPath;
console.log("  using Node.js " + spawnSync(exeNode, ["--version"], { encoding: "utf8" }).stdout.trim() + (ltsNode ? " (stable, from tools/bin/node-lts)" : ""));
const sea = spawnSync(exeNode, ["--build-sea", seaConfig], { encoding: "utf8" });
process.stdout.write((sea.stdout || "") + (sea.stderr || ""));
if (sea.status !== 0 || !fs.existsSync(exe)) fail("building the .exe failed");

// Make it a windowed program, so no black console window appears.
// (In the Windows .exe header: the "subsystem" field, 3 = console, 2 = windows.)
{
    const buf = fs.readFileSync(exe);
    const pe = buf.readUInt32LE(0x3c);
    if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") fail("unexpected .exe format");
    const subsystem = pe + 24 + 68;
    buf.writeUInt16LE(2, subsystem);
    fs.writeFileSync(exe, buf);
}

// ---- 4. Notes for users and licences ----------------------------------------------------
fs.writeFileSync(path.join(outDir, "READ ME FIRST.txt"), [
    "Makecode Arcade on 3ds - play MakeCode Arcade games on a Nintendo 3DS",
    "",
    "DISCLAIMER: this is an unofficial fan project. It is NOT made by, affiliated",
    "with, or endorsed by Microsoft or Microsoft MakeCode. MakeCode and Microsoft",
    "are trademarks of Microsoft Corporation. Games belong to the people who made them.",
    "",
    "1. Keep this whole folder somewhere you can write to (Documents or the",
    "   Desktop - not Program Files). Your games are kept in here too.",
    "2. Double-click \"MakeCode 3DS.exe\". Nothing else needs installing.",
    "   Windows may warn that the app is from an unknown publisher: choose",
    "   \"More info\" and \"Run anyway\". It may also ask whether the app may use",
    "   the network: allow it on private networks so your 3DS can find it.",
    "3. Paste a MakeCode Arcade share link and click Add game.",
    "",
    "On the 3DS (needs custom firmware with the Homebrew Launcher):",
    "- Copy the \"built 3ds games/makecode-arcade\" folder into the \"3ds\" folder",
    "  on the SD card (only the first time).",
    "- Install \"built 3ds games/Makecode Arcade on 3ds.cia\" with FBI to get it",
    "  on the HOME menu (or start makecode-arcade/library.3dsx from the",
    "  Homebrew Launcher).",
    "- After that, choose \"Get games from PC\" in the library to get new games",
    "  over Wi-Fi while the app is open on the PC.",
    "",
].join("\r\n"));

const licences = path.join(outDir, "LICENSES");
fs.mkdirSync(licences, { recursive: true });
const nodeLicence = path.join(path.dirname(exeNode), "LICENSE");
if (fs.existsSync(nodeLicence)) fs.copyFileSync(nodeLicence, path.join(licences, "Node.js.txt"));
const mkcLicence = ["LICENSE", "LICENSE.txt"].map(f => path.join(mkcSrc, f)).find(f => fs.existsSync(f));
if (mkcLicence) fs.copyFileSync(mkcLicence, path.join(licences, "makecode-cli.txt"));
fs.writeFileSync(path.join(licences, "README.txt"), [
    "Third-party parts in this download:",
    "",
    "- MakeCode Exe (MakeCode 3DS.exe) is built from Node.js (MIT licence, Node.js.txt).",
    "- mkc/makecode: the MakeCode command-line tools (MIT licence, makecode-cli.txt).",
    "- player/pxt: Microsoft MakeCode's C++ runtime, from pxt-common-packages and",
    "  pxt-arcade (MIT licence, Copyright (c) Microsoft Corporation).",
    "- library/font8x8.bin: the 8x8 font from libctru (zlib licence,",
    "  Copyright (C) 2014-2018 libctru contributors).",
    "- toolchain/: the assembler, linker and libraries used to build 3DS games, from",
    "  devkitPro's devkitARM and libctru. Their licences are in toolchain/LICENSES and",
    "  where to get their source code is in toolchain/src/SOURCES.txt. Not made or",
    "  endorsed by devkitPro.",
    "",
].join("\r\n"));

// ---- 5. Zip it -------------------------------------------------------------------------------
console.log("Making the zip...");
const zip = path.join(releaseDir, "MakeCode 3DS.zip");
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe") : "tar";
const z = spawnSync(tar, ["-a", "-c", "-f", zip, "MakeCode 3DS"], { cwd: releaseDir, encoding: "utf8" });
if (z.status !== 0) console.log("Could not make the zip (" + (z.stderr || "").trim() + "); the folder is ready anyway.");

const size = f => (fs.statSync(f).size / 1024 / 1024).toFixed(0) + " MB";
console.log(`\nDone:\n  ${outDir}\n  ${exe} (${size(exe)})`);
if (fs.existsSync(zip)) console.log(`  ${zip} (${size(zip)})`);
