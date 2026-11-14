// png.js
// Reads PNG images (any normal kind: palette, grey, RGB, with or without
// transparency; not interlaced) and turns them into the library's .art files.

const fs = require("fs");
const zlib = require("zlib");

// Returns { width, height, rgba } (rgba: Buffer, 4 bytes per pixel, row by row).
function readPng(file) {
    const buf = fs.readFileSync(file);
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG image`);
    let pos = 8, width, height, depth, type, interlace, palette = null, trns = null;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos), kind = buf.toString("latin1", pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (kind === "IHDR") {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8];
            type = data[9];
            interlace = data[12];
        } else if (kind === "PLTE") palette = data;
        else if (kind === "tRNS") trns = data;
        else if (kind === "IDAT") idat.push(data);
        else if (kind === "IEND") break;
        pos += 12 + len;
    }
    if (interlace) throw new Error(`${file}: interlaced PNGs are not supported; save it without interlacing`);
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
    if (!channels || (depth !== 8 && !(depth < 8 && (type === 0 || type === 3))))
        throw new Error(`${file}: unsupported PNG kind (colour type ${type}, ${depth}-bit)`);

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bitsPerPixel = channels * depth;
    const stride = Math.ceil(width * bitsPerPixel / 8);
    const bpp = Math.max(1, bitsPerPixel >> 3); // bytes back to the "left" pixel for filters
    const rows = Buffer.alloc(stride * height);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const out = rows.subarray(y * stride, (y + 1) * stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? out[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
            let v = line[i];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            out[i] = v & 0xff;
        }
        prev = out;
    }

    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = rows.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            let r, g, b, a = 255;
            if (depth < 8) { // palette or grey packed several pixels to a byte
                const per = 8 / depth, v = (row[Math.floor(x / per)] >> ((per - 1 - (x % per)) * depth)) & ((1 << depth) - 1);
                if (type === 3) {
                    r = palette[v * 3]; g = palette[v * 3 + 1]; b = palette[v * 3 + 2];
                    if (trns && v < trns.length) a = trns[v];
                } else {
                    r = g = b = Math.round(v * 255 / ((1 << depth) - 1));
                }
            } else if (type === 3) {
                const v = row[x];
                r = palette[v * 3]; g = palette[v * 3 + 1]; b = palette[v * 3 + 2];
                if (trns && v < trns.length) a = trns[v];
            } else if (type === 0) {
                r = g = b = row[x];
            } else if (type === 4) {
                r = g = b = row[x * 2]; a = row[x * 2 + 1];
            } else if (type === 2) {
                r = row[x * 3]; g = row[x * 3 + 1]; b = row[x * 3 + 2];
            } else {
                r = row[x * 4]; g = row[x * 4 + 1]; b = row[x * 4 + 2]; a = row[x * 4 + 3];
            }
            rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
        }
    }
    return { width, height, rgba };
}

// Pixel art is often saved enlarged (every art pixel a 4x4 block, say).
// Returns the image at its true size, so the 3DS can enlarge it by whole
// numbers and keep every pixel square and sharp.
function trueSize(img) {
    const same = (a, b) => img.rgba.readUInt32BE(a * 4) === img.rgba.readUInt32BE(b * 4);
    for (let k = Math.min(img.width, img.height); k >= 2; k--) {
        if (img.width % k || img.height % k) continue;
        let ok = true;
        for (let y = 0; y < img.height && ok; y++)
            for (let x = 0; x < img.width && ok; x++)
                if (!same(y * img.width + x, (y - y % k) * img.width + (x - x % k))) ok = false;
        if (!ok) continue;
        const w = img.width / k, h = img.height / k, rgba = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++)
                img.rgba.copy(rgba, (y * w + x) * 4, (y * k * img.width + x * k) * 4, (y * k * img.width + x * k) * 4 + 4);
        return { width: w, height: h, rgba };
    }
    return img;
}

// PNG -> .art ("ART1", width, height as 16-bit, then RGBA rows).
function pngToArt(pngFile, artFile) {
    const img = trueSize(readPng(pngFile));
    if (img.width > 1024 || img.height > 1024) throw new Error(`${pngFile} is too big (max 1024x1024)`);
    const head = Buffer.alloc(8);
    head.write("ART1", 0, "latin1");
    head.writeUInt16LE(img.width, 4);
    head.writeUInt16LE(img.height, 6);
    fs.writeFileSync(artFile, Buffer.concat([head, img.rgba]));
    return img;
}

module.exports = { readPng, pngToArt, trueSize };

// ---- writing ----------------------------------------------------------------------

function crc32(buf) {
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
        let c = (crc ^ buf[i]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return ~crc >>> 0;
}

function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
}

// Writes an RGBA image ({ width, height, rgba }) as a PNG file.
function writePng(file, img) {
    const { width, height, rgba } = img;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++)
        rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

module.exports.writePng = writePng;
