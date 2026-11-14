#!/usr/bin/env node
// make-3ds.js
// The one command: MakeCode Arcade link (or GitHub URL, or project folder) in,
// .3dsx out. Runs get-game.js and then build-3ds.js.
//
// Usage:
//   node tools/make-3ds.js <share link | GitHub URL | project folder> [--name <folder>] [--test]
//
//   --test   also run the game for 300 frames in the PC emulator (needs QEMU)
//            and save a screenshot, to check it starts before copying it over.

const path = require("path");
const { spawnSync } = require("child_process");

const args = process.argv.slice(2);
const testIt = args.includes("--test");
const rest = args.filter(a => a !== "--test");
if (!rest.length) {
    console.error("Usage: node tools/make-3ds.js <share link | GitHub URL | project folder> [--name <folder>] [--test]");
    process.exit(1);
}

function step(script, scriptArgs) {
    const r = spawnSync(process.execPath, [path.join(__dirname, script), ...scriptArgs],
        { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true });
    process.stdout.write(r.stdout || "");
    if (r.status !== 0) process.exit(r.status || 1);
    return r.stdout || "";
}

const out = step("get-game.js", rest);
const m = /^\s*Project:\s+(.+)$/m.exec(out);
if (!m) {
    console.error("Could not tell where the project was saved.");
    process.exit(1);
}
const projectDir = m[1].trim();

console.log("\n=== Building the 3DS program ===");
step("build-3ds.js", [projectDir]);

if (testIt) {
    console.log("\n=== Test run in the PC emulator ===");
    step("test-qemu.js", [projectDir, "--frames", "300"]);
}
