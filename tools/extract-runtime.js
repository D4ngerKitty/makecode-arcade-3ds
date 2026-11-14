#!/usr/bin/env node
// extract-runtime.js
// Copies MakeCode Arcade's C++ runtime sources out of mkc's cached target
// (the exact version the games are compiled against) into player/pxt/.
//
// Usage:  node tools/extract-runtime.js
// Run `mkc build` in any project once first, so the cache exists.

const fs = require("fs");
const os = require("os");
const path = require("path");

const cache = path.join(os.homedir(), ".pxt", "mkc-cache", "https_58__47__47_arcade.makecode.com-target.json");
if (!fs.existsSync(cache)) {
    console.error("MakeCode target cache not found. Build any game with tools/get-game.js first.");
    process.exit(1);
}
const target = JSON.parse(fs.readFileSync(cache, "utf8"));
const pkgs = target.bundledpkgs;
const outDir = path.join(__dirname, "..", "player", "pxt");

// package -> files to take. Everything hardware-specific (screen, sound
// output, buttons, threads) is written fresh for the 3DS in player/source.
const wanted = {
    "base": ["core.cpp", "gc.cpp", "pxt.cpp", "buffer.cpp", "control.cpp", "controlgc.cpp", "loops.cpp",
        "advmath.cpp", "trig.cpp", "pxtbase.h", "configkeys.h"],
    "screen---linux": ["image.cpp"],
    "mixer---linux": ["melody.cpp", "melody.h"],
    "shader": ["shader.cpp"],
};

// Small fixes applied to the upstream sources as they are copied.
const patches = {
    // Off Linux, image.cpp replaces the C library's memcpy with its own simple
    // loop. The 3DS C library's memcpy is already fast, and modern GCC can turn
    // that loop back into a memcpy call, i.e. into endless recursion.
    "screen---linux/image.cpp": text => {
        const marker = /#ifndef __linux__(\r?\nextern "C" void \*memcpy\()/;
        if (!marker.test(text)) throw new Error("image.cpp: memcpy override not found; update the patch");
        text = text.replace(marker, "#if 0 // disabled for the 3DS, see tools/extract-runtime.js$1");

        // blit() (scaled copy, used for zooming and scaled sprites) handled
        // every pixel through general-purpose get/set functions. Add a direct
        // path for the usual case - two different 16-colour images, not a
        // collision check - that produces the same pixels far faster.
        text = text.replace(/\r\n/g, "\n");
        const loop = "    for (int yDstCur = yDstStart, ySrcCur = ySrcStart; yDstCur < yDstEnd && ySrcCur < ySrcEnd; ++yDstCur, ySrcCur += ySrcStep) {\n        int ySrcCurI = ySrcCur >> 16;\n        for (int xDstCur = xDstStart, xSrcCur = xSrcStart;";
        if (text.split(loop).length !== 2) throw new Error("image.cpp: blit loop not found; update the patch");
        const fast = [
            "    if (!check && src != dst && src->bpp() == 4 && dst->bpp() == 4) {",
            "        // 3DS fast path. Images are stored column by column, 4 bits per pixel.",
            "        int srcColBytes = src->byteHeight(), dstColBytes = dst->byteHeight();",
            "        const uint8_t *srcPix = src->pix();",
            "        uint8_t *dstPix = dst->pix();",
            "        for (int xDstCur = xDstStart, xSrcCur = xSrcStart; xDstCur < xDstEnd && xSrcCur < xSrcEnd; ++xDstCur, xSrcCur += xSrcStep) {",
            "            const uint8_t *srcCol = srcPix + (xSrcCur >> 16) * srcColBytes;",
            "            uint8_t *dstCol = dstPix + xDstCur * dstColBytes;",
            "            for (int yDstCur = yDstStart, ySrcCur = ySrcStart; yDstCur < yDstEnd && ySrcCur < ySrcEnd; ++yDstCur, ySrcCur += ySrcStep) {",
            "                int ys = ySrcCur >> 16;",
            "                int c = (srcCol[ys >> 1] >> ((ys & 1) << 2)) & 0xf;",
            "                if (!transparent || c) {",
            "                    uint8_t *d = dstCol + (yDstCur >> 1);",
            "                    if (yDstCur & 1)",
            "                        *d = (*d & 0x0f) | (c << 4);",
            "                    else",
            "                        *d = (*d & 0xf0) | c;",
            "                }",
            "            }",
            "        }",
            "        return false;",
            "    }",
            "",
        ].join("\n");
        return text.replace(loop, () => fast + loop);
    },

    // The allocator keeps free memory as one list and, for every allocation,
    // walks it from the start until it finds a big-enough piece. In a large
    // game the start of the list fills up with tiny leftover pieces and that
    // walk dominated everything (about half of all CPU time in Frosthaven).
    // Fix: first try from where the previous allocation succeeded, and only
    // fall back to the full walk when that fails.
    "base/gc.cpp": text => {
        const edits = [
            // a "roving" start position
            ["static RefBlock *firstFree;",
                "static RefBlock *firstFree;\n// 3DS: free block just before the place the last allocation was made\nstatic RefBlock *roverPrev;"],
            // the list is rebuilt by sweep() and edited by gcAllocAt(): forget the position
            ["    uint32_t maxFreeBlock = 0;\n    firstFree = NULL;",
                "    uint32_t maxFreeBlock = 0;\n    firstFree = NULL;\n    roverPrev = NULL;"],
            ["static void *gcAllocAt(void *hint, int numbytes) {\n    gc(0);",
                "static void *gcAllocAt(void *hint, int numbytes) {\n    gc(0);\n    roverPrev = NULL;"],
            // Stock behaviour: add memory only once the heap is 90% full, which
            // keeps it small but means collecting garbage very often. The 3DS
            // has memory to spare: keep at least half the heap free (up to
            // 32 MB), so collections are rarer.
            ["    if (freeSize * 10 <= totalSize) {\n        allocateBlock();\n    }",
                "    {\n        uint32_t f = freeSize, t = totalSize;\n        while (f * 10 <= t || (f * 2 <= t && t < 32 * 1024 * 1024)) {\n            allocateBlock();\n            f += GC_BLOCK_SIZE;\n            t += GC_BLOCK_SIZE;\n        }\n    }"],
            // pass -1 is the quick try from the roving position
            ["    for (int i = 0;; ++i) {\n        RefBlock *prev = NULL;\n        for (auto p = firstFree; p; p = p->nextFree) {\n            VVLOG(\"p=%p\", p);\n            if (i == 0 && (uint8_t *)p > midPtr) {",
                "    for (int i = -1;; ++i) {\n        RefBlock *prev = NULL;\n        auto p = firstFree;\n        if (i == -1) {\n            if (!roverPrev)\n                continue;\n            prev = roverPrev;\n            p = prev->nextFree;\n        }\n        for (; p; p = p->nextFree) {\n            VVLOG(\"p=%p\", p);\n            if (i <= 0 && (uint8_t *)p > midPtr) {"],
            ["                    firstFree = nf;\n                p->setVT(0);",
                "                    firstFree = nf;\n                roverPrev = prev;\n                p->setVT(0);"],
            ["        // we didn't find anything, try GC\n        if (i == 0)",
                "        if (i == -1)\n            continue; // quick try failed: do the full walk\n\n        // we didn't find anything, try GC\n        if (i == 0)"],
        ];
        text = text.replace(/\r\n/g, "\n");
        for (const [from, to] of edits) {
            if (!text.includes(from)) throw new Error("gc.cpp: expected code not found; update the patch:\n" + from);
            text = text.replace(from, to);
        }
        return text;
    },
};

fs.rmSync(outDir, { recursive: true, force: true });
let n = 0;
for (const [pkg, files] of Object.entries(wanted)) {
    for (const f of files) {
        let text = pkgs[pkg] && pkgs[pkg][f];
        if (text === undefined) {
            console.warn(`Warning: ${pkg}/${f} is not in this MakeCode version; skipped.`);
            continue;
        }
        if (patches[pkg + "/" + f]) text = patches[pkg + "/" + f](text);
        const dst = path.join(outDir, pkg.replace(/---.*/, ""), f);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, text);
        n++;
    }
}
fs.writeFileSync(path.join(outDir, "VERSION.txt"),
    `MakeCode Arcade target ${target.versions.target}, pxt ${target.versions.pxt}\n`);
console.log(`Extracted ${n} runtime files (Arcade ${target.versions.target}) to ${outDir}`);
