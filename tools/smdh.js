// smdh.js
// Makes the SMDH block a .3dsx/.cia carries: its title, description,
// publisher and icon as shown in the Homebrew Launcher and HOME menu.
// Written for this project as a replacement for devkitPro's smdhtool (which
// carries no licence); tools/check-3dsx.js --smdh compares the two.
//
// Layout (14016 bytes): "SMDH", version, then 16 language entries of
// short title (64 UTF-16 characters), long description (128) and publisher
// (64); then settings (ratings, region, flags); then the icon twice, 24x24
// and 48x48, as 16-bit colour (RGB565) in 8x8 tiles with the pixels of each
// tile in "Z" order, which is how the 3DS's graphics chip reads textures.

const { readPng } = require("./png.js");

const SIZE = 0x36c0;

function writeUtf16(buf, offset, maxBytes, text) {
    const s = String(text || "");
    for (let i = 0, o = offset; i < s.length && o + 2 <= offset + maxBytes; i++, o += 2)
        buf.writeUInt16LE(s.charCodeAt(i), o);
}

// Position of the i-th pixel of an 8x8 tile, in Z order.
function zOrder(i) {
    const x = (i & 1) | ((i >> 1) & 2) | ((i >> 2) & 4);
    const y = ((i >> 1) & 1) | ((i >> 2) & 2) | ((i >> 3) & 4);
    return [x, y];
}

function rgb565(r, g, b) {
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

// Writes a square RGB image (size x size, 3 numbers per pixel) as tiled RGB565.
function writeIcon(buf, offset, rgb, size) {
    let o = offset;
    for (let ty = 0; ty < size; ty += 8)
        for (let tx = 0; tx < size; tx += 8)
            for (let i = 0; i < 64; i++, o += 2) {
                const [x, y] = zOrder(i);
                const p = ((ty + y) * size + tx + x) * 3;
                buf.writeUInt16LE(rgb565(rgb[p], rgb[p + 1], rgb[p + 2]), o);
            }
}

// icon: a 48x48 PNG file. Returns the SMDH as a Buffer.
function makeSmdh({ title, description, publisher, icon }) {
    const buf = Buffer.alloc(SIZE);
    buf.write("SMDH", 0, "latin1");
    for (let lang = 0; lang < 16; lang++) {
        const o = 8 + lang * 0x200;
        writeUtf16(buf, o, 0x80, title);
        writeUtf16(buf, o + 0x80, 0x100, description);
        writeUtf16(buf, o + 0x180, 0x80, publisher);
    }
    // Settings: age ratings marked "no restriction" where used, every region,
    // and flags "visible in HOME menu", "allow 3D" and "record usage".
    Buffer.from("a0a000a0a000a0a0a0a0a00000000000", "hex").copy(buf, 0x2008);
    buf.writeUInt32LE(0xffffffff, 0x2018);
    buf.writeUInt32LE(0x141, 0x2028);

    const img = readPng(icon);
    if (img.width !== 48 || img.height !== 48) throw new Error(`${icon} must be 48x48 (it is ${img.width}x${img.height})`);
    const large = new Array(48 * 48 * 3);
    for (let i = 0; i < 48 * 48; i++)
        for (let c = 0; c < 3; c++) large[i * 3 + c] = img.rgba[i * 4 + c];
    // The small icon: each pixel the (rounded) average of a 2x2 block of the
    // large one. (smdhtool uses a smoother resizing filter here, so this one
    // part is not byte-identical to its output; it looks the same.)
    const small = new Array(24 * 24 * 3);
    for (let y = 0; y < 24; y++)
        for (let x = 0; x < 24; x++)
            for (let c = 0; c < 3; c++) {
                const at = (yy, xx) => large[(yy * 48 + xx) * 3 + c];
                small[(y * 24 + x) * 3 + c] = Math.round((at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1)) / 4);
            }
    writeIcon(buf, 0x2040, small, 24);
    writeIcon(buf, 0x24c0, large, 48);
    return buf;
}

module.exports = { makeSmdh };
