#!/usr/bin/env node
// check-toolchain.js
// Checks that building with the bundled toolchain/ folder (no devkitPro)
// gives the same .3dsx as building with devkitPro, for every built game.
//
// Usage:  node tools/check-toolchain.js

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { gamesDir, gameFolders } = require("./paths.js");

function build(id, toolchain) {
    const r = spawnSync(process.execPath, [path.join(__dirname, "build-3ds.js"), id],
        { encoding: "utf8", env: { ...process.env, MCA3DS_TOOLCHAIN: toolchain }, windowsHide: true, maxBuffer: 1 << 28 });
    const file = path.join(gamesDir, id, "built", "3ds", id + ".3dsx");
    if (r.status !== 0 || !fs.existsSync(file)) return { error: ((r.stdout || "") + (r.stderr || "")).split(/\r?\n/).filter(l => l.trim()).slice(-4).join("\n") };
    return { data: fs.readFileSync(file), log: r.stdout };
}

let same = 0, different = 0;
for (const id of gameFolders()) {
    if (!fs.existsSync(path.join(gamesDir, id, "built", "3ds", "game.o"))) continue;
    const a = build(id, "devkitpro"), b = build(id, "bundled");
    if (a.error || b.error) { different++; console.log(`${id}: BUILD FAILED\n${a.error || b.error}`); continue; }
    if (!/ready-built runtime/.test(b.log)) { different++; console.log(`${id}: the bundled build did not use the bundled toolchain`); continue; }
    if (a.data.equals(b.data)) { same++; console.log(`${id}: identical`); }
    else {
        different++;
        let i = 0;
        while (i < a.data.length && a.data[i] === b.data[i]) i++;
        console.log(`${id}: DIFFERENT (devkitPro ${a.data.length} bytes, bundled ${b.data.length}; first difference at ${i})`);
    }
}
console.log(`\n${same} identical, ${different} different.`);
process.exit(different ? 1 : 0);
