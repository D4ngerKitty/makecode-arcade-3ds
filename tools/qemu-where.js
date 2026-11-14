#!/usr/bin/env node
// qemu-where.js
// Debug helper: runs a game under QEMU for a few seconds, pauses it, and
// prints which game functions it is in (innermost first). Use it when a game
// hangs or is slow in tools/test-qemu.js.
//
// Usage:  node tools/qemu-where.js <project folder> [seconds] ["harness args"]

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { bin, fail } = require("./player-build.js");

const projectDir = path.resolve(process.argv[2] || "");
const seconds = Number(process.argv[3] || 6);
const append = process.argv[4] || "frames=100000";
const elf = path.join(projectDir, "built", "qemu", path.basename(projectDir) + ".elf");
if (!fs.existsSync(elf)) fail("Run tools/test-qemu.js on the project first.");
const qemuExe = [process.env.QEMU_SYSTEM_ARM, "C:/Program Files/qemu/qemu-system-arm.exe", "/usr/bin/qemu-system-arm"]
    .filter(p => p && fs.existsSync(p))[0];

// Function symbols, sorted by address.
const syms = spawnSync(bin("nm"), ["-C", "-n", elf], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout.split(/\r?\n/)
    .map(l => /^([0-9a-f]{8}) [TtWw] (.+)$/.exec(l)).filter(m => m)
    .map(m => ({ addr: parseInt(m[1], 16), name: m[2] }))
    .filter(s => !/^\$|^\.L/.test(s.name));
function symbolize(addr) {
    let lo = 0, hi = syms.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (syms[mid].addr <= addr) lo = mid; else hi = mid - 1;
    }
    return syms[lo].addr <= addr && addr - syms[lo].addr < 0x4000 ? syms[lo].name : null;
}
const textEnd = Math.max(...syms.map(s => s.addr));

const qemu = spawn(qemuExe, ["-M", "versatilepb", "-cpu", "arm1176", "-m", "256", "-nographic", "-monitor", "none",
    "-serial", "none", "-semihosting-config", "enable=on,target=native", "-kernel", elf, "-append", append,
    "-gdb", "tcp::1234"], { stdio: ["ignore", "inherit", "inherit"] });

setTimeout(() => {
    const g = spawnSync(bin("gdb"), ["-batch", "-ex", "set pagination off", "-ex", "target remote :1234",
        "-ex", "printf \"PC %x LR %x\\n\", $pc, $lr", "-ex", "x/600xw $sp", "-ex", "kill", elf], { encoding: "utf8" });
    qemu.kill();
    const out = g.stdout || "";
    const reg = /PC ([0-9a-f]+) LR ([0-9a-f]+)/.exec(out);
    const chain = [];
    const add = a => {
        const n = symbolize(a & ~1);
        if (n && chain[chain.length - 1] !== n) chain.push(n);
    };
    if (reg) { add(parseInt(reg[1], 16)); add(parseInt(reg[2], 16)); }
    for (const line of out.split(/\r?\n/)) {
        const m = /^0x[0-9a-f]+[^:]*:\s+(.*)$/.exec(line);
        if (!m) continue;
        for (const w of m[1].trim().split(/\s+/)) {
            const v = parseInt(w, 16);
            if (v > 0x8000 && v < textEnd + 0x4000) add(v);
        }
    }
    console.log("\nPaused after " + seconds + "s. Functions on the stack (innermost first):");
    for (const n of chain.slice(0, 40)) console.log("  " + n);
    process.exit(0);
}, seconds * 1000);
