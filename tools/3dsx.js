// 3dsx.js
// Turns a linked 3DS program (.elf) into a .3dsx, the format the Homebrew
// Launcher (and Luma3DS's loader) run. Written for this project from the
// published layout of the format, as a replacement for devkitPro's 3dsxtool
// (which carries no licence, so cannot be redistributed with the app).
// tools/check-3dsx.js compares its output with 3dsxtool's, byte for byte.
//
// Layout: header (32 bytes, or 44 with the extended header for the icon),
// three relocation headers (code, rodata, data), the three segments, the
// relocation tables, then the SMDH (icon and title) if there is one.
//
// Relocations tell the loader which 32-bit words hold addresses. Addresses
// are stored as offsets from the program's base (the code segment's start);
// the loader adds wherever it actually put each segment. "Absolute" entries
// become plain addresses; "relative" ones become (address - word's own
// address).

const fs = require("fs");

const R_ARM_ABS32 = 2, R_ARM_REL32 = 3, R_ARM_TARGET1 = 38, R_ARM_TARGET2 = 41, R_ARM_TLS_IE32 = 107;

function readElf(buf) {
    if (buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 1 || buf[5] !== 1)
        throw new Error("not a 32-bit little-endian ELF file");
    const phoff = buf.readUInt32LE(0x1c), phentsize = buf.readUInt16LE(0x2a), phnum = buf.readUInt16LE(0x2c);
    const shoff = buf.readUInt32LE(0x20), shentsize = buf.readUInt16LE(0x2e), shnum = buf.readUInt16LE(0x30);
    const segments = [], sections = [];
    for (let i = 0; i < phnum; i++) {
        const p = phoff + i * phentsize;
        segments.push({ type: buf.readUInt32LE(p), offset: buf.readUInt32LE(p + 4), vaddr: buf.readUInt32LE(p + 8),
            filesz: buf.readUInt32LE(p + 16), memsz: buf.readUInt32LE(p + 20), flags: buf.readUInt32LE(p + 24) });
    }
    for (let i = 0; i < shnum; i++) {
        const s = shoff + i * shentsize;
        sections.push({ type: buf.readUInt32LE(s + 4), flags: buf.readUInt32LE(s + 8), addr: buf.readUInt32LE(s + 12),
            offset: buf.readUInt32LE(s + 16), size: buf.readUInt32LE(s + 20), link: buf.readUInt32LE(s + 24), info: buf.readUInt32LE(s + 28) });
    }
    return { segments, sections };
}

// Encodes sorted word positions (within a segment) as (skip, patch) pairs.
function encodeRelocs(positions) {
    const out = [];
    let cur = 0, i = 0;
    while (i < positions.length) {
        let skip = positions[i] - cur;
        while (skip > 0xffff) {
            out.push([0xffff, 0]);
            skip -= 0xffff;
        }
        let run = 1;
        while (i + run < positions.length && positions[i + run] === positions[i] + run) run++;
        let first = true;
        while (run > 0) {
            const n = Math.min(run, 0xffff);
            out.push([first ? skip : 0, n]);
            first = false;
            i += n;
            run -= n;
        }
        cur = positions[i - 1] + 1;
    }
    return out;
}

// elf: Buffer of a linked program. smdh: Buffer (14016 bytes) or null.
function elfTo3dsx(elf, smdh) {
    const { segments, sections } = readElf(elf);
    const loads = segments.filter(s => s.type === 1 && s.memsz > 0);
    const code = loads.find(s => (s.flags & 1)); // executable
    const rodata = loads.find(s => !(s.flags & 1) && !(s.flags & 2));
    const data = loads.find(s => (s.flags & 2)); // writable
    if (!code) throw new Error("the program has no code segment");
    const segs = [code, rodata || null, data || null];
    const base = code.vaddr;
    const segIndexOf = addr => {
        for (let k = 0; k < 3; k++) {
            const s = segs[k];
            if (s && addr >= s.vaddr && addr < s.vaddr + s.memsz) return k;
        }
        return -1;
    };

    // Segment contents as they will be stored (file part only; bss is just a size).
    const contents = segs.map(s => s ? Buffer.from(elf.subarray(s.offset, s.offset + s.filesz)) : Buffer.alloc(0));
    const abs = [[], [], []], rel = [[], [], []];

    const symtab = sections.find(s => s.type === 2);
    const symbolSection = idx => symtab ? elf.readUInt16LE(symtab.offset + idx * 16 + 14) : 1;

    for (const relSec of sections) {
        if (relSec.type !== 9) continue; // SHT_REL
        const target = sections[relSec.info];
        if (!target || !(target.flags & 2)) continue; // only parts that are loaded
        for (let o = relSec.offset; o < relSec.offset + relSec.size; o += 8) {
            const at = elf.readUInt32LE(o), info = elf.readUInt32LE(o + 4);
            const type = info & 0xff, symIdx = info >>> 8;
            const k = segIndexOf(at);
            if (k < 0) continue;
            const pos = at - segs[k].vaddr;
            if (pos + 4 > contents[k].length) continue; // inside bss: nothing stored
            const word = contents[k].readUInt32LE(pos);
            if (type === R_ARM_ABS32 || type === R_ARM_TARGET1) {
                if (symbolSection(symIdx) === 0) continue; // missing optional symbol: stays 0
                contents[k].writeUInt32LE((word - base) >>> 0, pos);
                abs[k].push(pos >> 2);
            } else if (type === R_ARM_REL32 || type === R_ARM_TARGET2 || type === R_ARM_TLS_IE32) {
                contents[k].writeUInt32LE((at + word - base) >>> 0, pos);
                rel[k].push(pos >> 2);
            }
            // Branches and calls (CALL, JUMP24, THM_CALL, ...) are relative
            // within the code and need nothing at load time.
        }
    }

    const tables = [0, 1, 2].map(k => ({
        abs: encodeRelocs([...new Set(abs[k])].sort((a, b) => a - b)),
        rel: encodeRelocs([...new Set(rel[k])].sort((a, b) => a - b)),
    }));

    const headerSize = smdh ? 44 : 32;
    const relocHeaderSize = 8;
    const header = Buffer.alloc(headerSize);
    header.write("3DSX", 0, "latin1");
    header.writeUInt16LE(headerSize, 4);
    header.writeUInt16LE(relocHeaderSize, 6);
    header.writeUInt32LE(0, 8); // format version
    header.writeUInt32LE(0, 12); // flags
    header.writeUInt32LE(contents[0].length, 16);
    header.writeUInt32LE(contents[1].length, 20);
    const bss = data ? data.memsz - data.filesz : 0;
    header.writeUInt32LE(contents[2].length + bss, 24);
    header.writeUInt32LE(bss, 28);

    const relocHeaders = Buffer.alloc(3 * relocHeaderSize);
    tables.forEach((t, k) => {
        relocHeaders.writeUInt32LE(t.abs.length, k * relocHeaderSize);
        relocHeaders.writeUInt32LE(t.rel.length, k * relocHeaderSize + 4);
    });
    const relocData = [];
    for (const t of tables)
        for (const list of [t.abs, t.rel])
            for (const [skip, patch] of list) {
                const e = Buffer.alloc(4);
                e.writeUInt16LE(skip, 0);
                e.writeUInt16LE(patch, 2);
                relocData.push(e);
            }

    const parts = [header, relocHeaders, ...contents, ...relocData];
    if (smdh) {
        const offset = parts.reduce((n, b) => n + b.length, 0);
        header.writeUInt32LE(offset, 32);
        header.writeUInt32LE(smdh.length, 36);
        header.writeUInt32LE(0, 40); // no RomFS
        parts.push(smdh);
    }
    return Buffer.concat(parts);
}

module.exports = { elfTo3dsx, readElf, encodeRelocs };

if (require.main === module) {
    const [elfPath, outPath, smdhPath] = process.argv.slice(2);
    if (!elfPath || !outPath) {
        console.error("Usage: node tools/3dsx.js <program.elf> <out.3dsx> [icon.smdh]");
        process.exit(1);
    }
    fs.writeFileSync(outPath, elfTo3dsx(fs.readFileSync(elfPath), smdhPath ? fs.readFileSync(smdhPath) : null));
}
