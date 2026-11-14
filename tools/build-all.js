#!/usr/bin/env node
// build-all.js
// Rebuilds every game folder in the project, so they all pick up the latest
// tools and runtime. Finished games end up in "built 3ds games/".
//
// Usage:  node tools/build-all.js [--quick]
//
//   --quick   only re-link with the runtime (build-3ds.js) for games that have
//             been compiled before; use after changing player/ only. Without
//             it each game is recompiled from its source too (slower).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const quick = process.argv.includes("--quick");
const { gamesDir, gameFolders } = require("./paths.js");
const games = gameFolders();

const results = [];
for (const game of games) {
    const dir = path.join(gamesDir, game);
    const compiled = fs.existsSync(path.join(dir, "built", "3ds", "game.o"));
    const script = quick && compiled ? "build-3ds.js" : "make-3ds.js";
    process.stdout.write(`${game} ... `);
    const r = spawnSync(process.execPath, [path.join(__dirname, script), dir], { encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true });
    const ok = r.status === 0;
    console.log(ok ? "ok" : "FAILED");
    if (!ok) {
        const lines = ((r.stdout || "") + (r.stderr || "")).split(/\r?\n/)
            .filter(l => /error|ERROR|not have yet|^\s{2}\S+::/.test(l) && !/program too large/.test(l));
        for (const l of lines.slice(0, 8)) console.log("    " + l.trim());
    }
    results.push({ game, ok });
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} games built into "built 3ds games".`);
if (failed.length) console.log("Failed: " + failed.map(r => r.game).join(", "));
