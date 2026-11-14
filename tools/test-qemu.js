#!/usr/bin/env node
// test-qemu.js
// Runs a game on the PC under QEMU (an ARM emulator) using the same runtime
// and the same compiled game code as the 3DS build - no 3DS needed. There is
// no window: it prints the log and saves screenshots as PNG files.
//
// Usage:
//   node tools/test-qemu.js <project folder> [--frames 600] [--shots 60,300]
//                           [--input "120:A:1,130:A:0"]
//
//   --frames  how many frames to run (default 300; the last one is always saved)
//   --shots   frame numbers to save as <project>/built/qemu/frame_NNNNN.png
//   --input   button script: frame:BUTTON:1 presses, frame:BUTTON:0 releases.
//             Buttons: UP DOWN LEFT RIGHT A B X Y L R ZL ZR START
//
// Needs QEMU (winget install SoftwareFreedomConservancy.QEMU) and devkitPro.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { buildPlayer, fail } = require("./player-build.js");

const args = process.argv.slice(2);
function option(name, defl) {
    const i = args.indexOf(name);
    if (i < 0) return defl;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
}
const frames = option("--frames", "300");
const shots = option("--shots", "");
const input = option("--input", "");
const profileFrom = option("--profile", ""); // frame number to start profiling at
const timeoutSec = Number(option("--timeout", "600"));
if (!args[0]) fail("Usage: node tools/test-qemu.js <project folder> [--frames N] [--shots a,b] [--input script]");
const projectDir = require("./paths.js").resolveGame(args[0]);

const qemu = [process.env.QEMU_SYSTEM_ARM, "C:/Program Files/qemu/qemu-system-arm.exe", "/usr/bin/qemu-system-arm"]
    .filter(p => p && fs.existsSync(p))[0];
if (!qemu) fail("QEMU was not found. Install it with: winget install SoftwareFreedomConservancy.QEMU");

const outBase = buildPlayer(projectDir, "qemu");
const outDir = path.dirname(outBase);
for (const f of fs.readdirSync(outDir))
    if (/^frame_\d+\.(ppm|png)$/.test(f)) fs.rmSync(path.join(outDir, f));

// The harness reads its settings from harness.txt in its working folder.
const settings = [`frames=${frames}`, shots && `shots=${shots}`, input && `input=${input}`,
    profileFrom && `profile=${profileFrom}`].filter(s => s);
fs.rmSync(path.join(outDir, "profile.bin"), { force: true });
fs.writeFileSync(path.join(outDir, "harness.txt"), settings.join("\n") + "\n");
console.log(`\nRunning under QEMU (frames=${frames})...\n`);
const started = Date.now();
const r = spawnSync(qemu, [
    "-M", "versatilepb", "-cpu", "arm1176", "-m", "256", "-nographic", "-monitor", "none", "-serial", "none",
    "-semihosting-config", "enable=on,target=native",
    // The emulated clock ticks once per instruction, so the harness can count
    // instructions per frame (a measure of work that does not depend on this PC).
    "-icount", "shift=0,sleep=off",
    "-kernel", outBase + ".elf",
], { cwd: outDir, stdio: ["ignore", "inherit", "inherit"], timeout: timeoutSec * 1000 });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

// ---- profile: where did the instructions go? ---------------------------------

const profilePath = path.join(outDir, "profile.bin");
if (fs.existsSync(profilePath)) {
    const { bin } = require("./player-build.js");
    const nm = spawnSync(bin("nm"), ["-C", "-n", outBase + ".elf"], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout;
    const syms = nm.split(/\r?\n/).map(l => /^([0-9a-f]{8}) [TtWw] (.+)$/.exec(l)).filter(m => m)
        .map(m => ({ addr: parseInt(m[1], 16), name: m[2] }))
        // Drop labels that sit in the middle of functions, so samples are
        // counted against the function they are in.
        .filter(s => !/^\$|^\.L|^_proccall\d+$|^_ldlit|_(locals|end|args|Lit|nochk|pre)$/.test(s.name) || /^pxt_user_/.test(s.name));
    const find = name => (syms.find(s => s.name === name) || {}).addr;
    const gameStart = find("pxt_user_start"), gameEnd = find("pxt_user_end");
    const buf = fs.readFileSync(profilePath);
    const counts = new Map();
    let total = 0, inGame = 0;
    for (let i = 0; i + 4 <= buf.length; i += 4) {
        const pc = buf.readUInt32LE(i);
        let lo = 0, hi = syms.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (syms[mid].addr <= pc) lo = mid; else hi = mid - 1;
        }
        const isGame = pc >= gameStart && pc < gameEnd;
        if (isGame) inGame++;
        const name = (isGame ? "[game] " : "") + syms[lo].name.replace(/\(.*$/, "");
        counts.set(name, (counts.get(name) || 0) + 1);
        total++;
    }
    console.log(`\nProfile from frame ${profileFrom} (${total} samples; ${(100 * inGame / total).toFixed(0)}% in game code, ` +
        `${(100 - 100 * inGame / total).toFixed(0)}% in the runtime):`);
    for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 35))
        console.log(`  ${(100 * n / total).toFixed(1).padStart(5)}%  ${name}`);
}

// ---- convert the saved frames (PPM) to PNG -----------------------------------

function crc32(buf) {
    let c, crc = ~0;
    for (let i = 0; i < buf.length; i++) {
        c = (crc ^ buf[i]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return ~crc >>> 0;
}
function pngChunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
}
function ppmToPng(ppm, scale) {
    const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.subarray(0, 32).toString("latin1"));
    if (!m) return null;
    const w = Number(m[1]), h = Number(m[2]), pix = ppm.subarray(m[0].length);
    const W = w * scale, H = h * scale;
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
        const row = y * (W * 3 + 1);
        for (let x = 0; x < W; x++)
            pix.copy(raw, row + 1 + x * 3, (Math.floor(y / scale) * w + Math.floor(x / scale)) * 3,
                (Math.floor(y / scale) * w + Math.floor(x / scale)) * 3 + 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr),
        pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
const saved = [];
for (const f of fs.readdirSync(outDir).sort()) {
    if (!/^frame_\d+\.ppm$/.test(f)) continue;
    const png = ppmToPng(fs.readFileSync(path.join(outDir, f)), 2);
    if (png) {
        const out = path.join(outDir, f.replace(".ppm", ".png"));
        fs.writeFileSync(out, png);
        saved.push(out);
    }
    fs.rmSync(path.join(outDir, f));
}

console.log(`\nFinished in ${seconds}s` + (r.error ? ` (stopped: ${r.error.code || r.error.message})` : `, exit code ${r.status}`));
for (const s of saved) console.log("Screenshot: " + s);
process.exit(r.status === 0 ? 0 : 1);
