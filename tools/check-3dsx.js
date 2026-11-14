#!/usr/bin/env node
// check-3dsx.js
// Checks tools/3dsx.js against devkitPro's 3dsxtool: for every built game,
// converts its .elf both ways and compares the files byte for byte.
// (3dsxtool needs the "pack.elf" copy that build-3ds.js makes, with the
// Thumb call notes blanked; this script makes that copy the same way.)
//
// Usage:  node tools/check-3dsx.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { elfTo3dsx } = require("./3dsx.js");
const { gamesDir, gameFolders } = require("./paths.js");
const { tool } = require("./player-build.js");

let same = 0, different = 0;
for (const id of gameFolders()) {
    const dir = path.join(gamesDir, id, "built", "3ds");
    const elf = path.join(dir, id + ".elf"), smdh = path.join(dir, id + ".smdh");
    if (!fs.existsSync(elf) || !fs.existsSync(smdh)) continue;
    // The same Thumb-note blanking build-3ds.js does before 3dsxtool.
    const buf = fs.readFileSync(elf);
    const shoff = buf.readUInt32LE(0x20), shentsize = buf.readUInt16LE(0x2e), shnum = buf.readUInt16LE(0x30);
    const keep = new Set([2, 3, 38, 41, 42]);
    for (let i = 0; i < shnum; i++) {
        const sh = shoff + i * shentsize;
        if (buf.readUInt32LE(sh + 4) !== 9) continue;
        const off = buf.readUInt32LE(sh + 16), size = buf.readUInt32LE(sh + 20);
        for (let r = off; r < off + size; r += 8) {
            const addr = buf.readUInt32LE(r), info = buf.readUInt32LE(r + 4);
            if ((addr & 3) === 0 || keep.has(info & 0xff)) continue;
            buf.writeUInt32LE((addr & ~3) >>> 0, r);
            buf.writeUInt32LE((info & ~0xff) >>> 0, r + 4);
        }
    }
    const tmpElf = path.join(os.tmpdir(), "check3dsx.elf"), theirs = path.join(os.tmpdir(), "check3dsx.3dsx");
    fs.writeFileSync(tmpElf, buf);
    const r = spawnSync(tool("3dsxtool"), [tmpElf, theirs, "--smdh=" + smdh], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) { console.log(`${id}: 3dsxtool failed: ${r.stdout}${r.stderr}`); continue; }
    const a = fs.readFileSync(theirs), b = elfTo3dsx(buf, fs.readFileSync(smdh));
    if (a.equals(b)) { same++; console.log(`${id}: identical (${a.length} bytes)`); continue; }
    different++;
    let first = 0;
    while (first < Math.min(a.length, b.length) && a[first] === b[first]) first++;
    console.log(`${id}: DIFFERENT - 3dsxtool ${a.length} bytes, ours ${b.length}; first difference at byte ${first}`);
}
console.log(`\n${same} identical, ${different} different.`);
process.exit(different ? 1 : 0);
