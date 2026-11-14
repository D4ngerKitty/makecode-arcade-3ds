#!/usr/bin/env node
// make-app-art.js
// Makes the library app's HOME-menu icon and banner from its logo:
//
//   library/logo.png          ->  library/icon.png    (48x48, the HOME-menu icon)
//   library/banner-art.png    ->  library/banner.png  (256x128, shown on the top
//     (used exactly as drawn)                           screen when the icon is picked)
//   library/banner-source.wav ->  library/banner.wav  (the startup sound)
//
// The banner is the art with its background colour cut out, a drop shadow,
// and the app's name in the 3DS's own pixel font (library/font8x8.bin), on
// the library's background colour. The HOME menu only plays about 3 seconds
// of sound, so the sound is cut to its first 3 seconds (after any silence)
// with a short fade-out.
// Replace icon.png or banner.png with your own art at any time; this script
// only needs running again if the logo changes.
//
// Usage:  node tools/make-app-art.js

const fs = require("fs");
const path = require("path");
const { readPng, writePng, trueSize } = require("./png.js");

const libDir = path.join(__dirname, "..", "library");
const logo = readPng(path.join(libDir, "logo.png"));
const font = fs.readFileSync(path.join(libDir, "font8x8.bin"));

// Background colour: the library's, from theme.cfg.
const theme = fs.readFileSync(path.join(libDir, "theme.cfg"), "utf8");
const bgHex = (/background\s*=\s*#?([0-9a-f]{6})/i.exec(theme) || [, "05081c"])[1];
const BG = [parseInt(bgHex.slice(0, 2), 16), parseInt(bgHex.slice(2, 4), 16), parseInt(bgHex.slice(4, 6), 16)];

function newImage(width, height, rgb) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = rgb[0];
        rgba[i * 4 + 1] = rgb[1];
        rgba[i * 4 + 2] = rgb[2];
        rgba[i * 4 + 3] = 255;
    }
    return { width, height, rgba };
}

// The part of an image that is not transparent.
function crop(img) {
    let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
    for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++)
            if (img.rgba[(y * img.width + x) * 4 + 3] > 8) {
                x0 = Math.min(x0, x); x1 = Math.max(x1, x);
                y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            }
    const w = x1 - x0 + 1, h = y1 - y0 + 1, rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
        img.rgba.copy(rgba, y * w * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x1 + 1) * 4);
    return { width: w, height: h, rgba };
}

// Smooth shrink: each new pixel is the average of the old pixels it covers.
function resize(img, w, h) {
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const sx0 = x * img.width / w, sx1 = (x + 1) * img.width / w;
            const sy0 = y * img.height / h, sy1 = (y + 1) * img.height / h;
            let r = 0, g = 0, b = 0, a = 0, total = 0;
            for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++)
                for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
                    const cover = (Math.min(sx + 1, sx1) - Math.max(sx, sx0)) * (Math.min(sy + 1, sy1) - Math.max(sy, sy0));
                    const p = (sy * img.width + sx) * 4, alpha = img.rgba[p + 3] / 255 * cover;
                    r += img.rgba[p] * alpha; g += img.rgba[p + 1] * alpha; b += img.rgba[p + 2] * alpha;
                    a += alpha; total += cover;
                }
            const o = (y * w + x) * 4;
            out[o] = a ? r / a : 0; out[o + 1] = a ? g / a : 0; out[o + 2] = a ? b / a : 0;
            out[o + 3] = Math.round(a / total * 255);
        }
    return { width: w, height: h, rgba: out };
}

// Draws `src` onto `dst` at (x, y), blending by transparency. `tint` replaces
// its colour (used for shadows), `opacity` fades it.
function paste(dst, src, x, y, tint, opacity = 1) {
    for (let sy = 0; sy < src.height; sy++)
        for (let sx = 0; sx < src.width; sx++) {
            const dx = x + sx, dy = y + sy;
            if (dx < 0 || dy < 0 || dx >= dst.width || dy >= dst.height) continue;
            const s = (sy * src.width + sx) * 4, d = (dy * dst.width + dx) * 4;
            const a = src.rgba[s + 3] / 255 * opacity;
            for (let c = 0; c < 3; c++) {
                const v = tint ? tint[c] : src.rgba[s + c];
                dst.rgba[d + c] = Math.round(v * a + dst.rgba[d + c] * (1 - a));
            }
        }
}

// Pixel-font text as an image (white, transparent background).
function textImage(text, scale) {
    const img = { width: text.length * 8 * scale, height: 8 * scale, rgba: Buffer.alloc(text.length * 64 * scale * scale * 4) };
    for (let i = 0; i < text.length; i++)
        for (let row = 0; row < 8; row++)
            for (let col = 0; col < 8; col++)
                if (font[text.charCodeAt(i) * 8 + row] & (0x80 >> col))
                    for (let yy = 0; yy < scale; yy++)
                        for (let xx = 0; xx < scale; xx++) {
                            const o = ((row * scale + yy) * img.width + (i * 8 + col) * scale + xx) * 4;
                            img.rgba[o] = img.rgba[o + 1] = img.rgba[o + 2] = img.rgba[o + 3] = 255;
                        }
    return img;
}

// Makes the flat background of a picture transparent: starting from the
// edges, every connected pixel close to the corner colour is removed, and
// pixels just inside that are partly faded so the outline stays smooth.
function removeBackground(img) {
    const w = img.width, h = img.height, px = img.rgba;
    const bg = [px[0], px[1], px[2]];
    const dist = i => Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2]);
    const NEAR = 70, EDGE = 140;
    const removed = new Uint8Array(w * h), stack = [];
    for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
    while (stack.length) {
        const i = stack.pop();
        if (removed[i] || dist(i) > NEAR) continue;
        removed[i] = 1;
        const x = i % w, y = (i / w) | 0;
        if (x > 0) stack.push(i - 1);
        if (x < w - 1) stack.push(i + 1);
        if (y > 0) stack.push(i - w);
        if (y < h - 1) stack.push(i + w);
    }
    // Background enclosed by the picture (not reachable from the edges) goes
    // too, but only where the colour is almost exactly the background's.
    for (let i = 0; i < w * h; i++)
        if (dist(i) < 45) removed[i] = 1;
    const out = Buffer.from(px);
    for (let i = 0; i < w * h; i++) {
        if (removed[i]) { out[i * 4 + 3] = 0; continue; }
        const x = i % w, y = (i / w) | 0;
        const touches = (x > 0 && removed[i - 1]) || (x < w - 1 && removed[i + 1]) ||
            (y > 0 && removed[i - w]) || (y < h - 1 && removed[i + w]);
        const d = dist(i);
        if (touches && d < EDGE) out[i * 4 + 3] = Math.round(255 * (d - NEAR) / (EDGE - NEAR));
    }
    return { width: w, height: h, rgba: out };
}

const shape = crop(logo);
const shadow = [0, 0, 0];

// ---- icon: 48x48, the logo on a background ------------------------------------
// HOME-menu icons cannot be see-through, so the logo sits on a solid colour:
// "icon = #rrggbb" in theme.cfg, or the library's background colour.
{
    const iconHex = (/^\s*icon\s*=\s*#?([0-9a-f]{6})/im.exec(theme) || [, bgHex])[1];
    const ICON_BG = [0, 2, 4].map(i => parseInt(iconHex.slice(i, i + 2), 16));
    const icon = newImage(48, 48, ICON_BG);
    // The logo shrunk smoothly to 44 pixels wide, centred.
    const w = 44, h = Math.round(shape.height * w / shape.width);
    const small = resize(shape, w, h);
    paste(icon, small, 2, Math.round((48 - h) / 2));
    writePng(path.join(libDir, "icon.png"), icon);
}

// ---- banner: 256x128 ---------------------------------------------------------------
// With library/banner-art-large.png (a big version of the art): its drawn part
// shrunk smoothly to fill the banner as far as it goes without cropping.
// Else with library/banner-art.png: that picture exactly as drawn - same pixels,
// same transparency, nothing added - centred on a transparent 256x128 banner.
// Only empty (fully transparent) edges are left out; it is never resized, so a
// picture whose drawn part is bigger than 256x128 is refused.
// Without it: the logo with a drop shadow and the app's name.
{
    const artFile = path.join(libDir, "banner-art.png");
    const largeFile = path.join(libDir, "banner-art-large.png");
    if (fs.existsSync(largeFile)) {
        // A big version of the art: shrink it (smoothly) until its drawn part
        // fills the banner as much as possible without cutting anything off,
        // and centre it on a transparent banner.
        const art = crop(readPng(largeFile));
        const scale = Math.min(256 / art.width, 128 / art.height);
        const w = Math.max(1, Math.round(art.width * scale)), h = Math.max(1, Math.round(art.height * scale));
        const fitted = resize(art, w, h);
        const banner = { width: 256, height: 128, rgba: Buffer.alloc(256 * 128 * 4) };
        const ox = Math.floor((256 - w) / 2), oy = Math.floor((128 - h) / 2);
        for (let y = 0; y < h; y++)
            fitted.rgba.copy(banner.rgba, ((oy + y) * 256 + ox) * 4, y * w * 4, (y + 1) * w * 4);
        writePng(path.join(libDir, "banner.png"), banner);
        console.log(`Banner: banner-art-large.png fitted to ${w}x${h}.`);
    } else if (fs.existsSync(artFile)) {
        const art = crop(readPng(artFile));
        if (art.width > 256 || art.height > 128)
            throw new Error(`The drawn part of banner-art.png is ${art.width}x${art.height}; a banner is 256x128. Please make it fit (it is not resized, to keep the art exactly as drawn).`);
        const banner = { width: 256, height: 128, rgba: Buffer.alloc(256 * 128 * 4) }; // fully transparent
        const ox = Math.floor((256 - art.width) / 2), oy = Math.floor((128 - art.height) / 2);
        for (let y = 0; y < art.height; y++)
            art.rgba.copy(banner.rgba, ((oy + y) * 256 + ox) * 4, y * art.width * 4, (y + 1) * art.width * 4);
        writePng(path.join(libDir, "banner.png"), banner);
    } else {
        const banner = newImage(256, 128, BG);
        // A soft lighter glow behind the logo, for depth.
        for (let y = 0; y < 128; y++)
            for (let x = 0; x < 256; x++) {
                const d = Math.hypot((x - 58) / 70, (y - 64) / 56), k = Math.max(0, 1 - d) * 0.22;
                const o = (y * 256 + x) * 4;
                for (let c = 0; c < 3; c++) banner.rgba[o + c] = Math.round(banner.rgba[o + c] * (1 - k) + 120 * k);
            }
        const h = 76, w = Math.round(shape.width * h / shape.height);
        const big = resize(shape, w, h);
        const lx = 60 - Math.round(w / 2), ly = Math.round((128 - h) / 2);
        paste(banner, big, lx + 4, ly + 5, shadow, 0.55); // drop shadow
        paste(banner, big, lx, ly);
        const lines = [["MakeCode", [255, 255, 255]], ["Arcade", [255, 255, 255]], ["on 3DS", [255, 216, 64]]];
        let ty = 26;
        for (const [text, colour] of lines) {
            const t = textImage(text, 2);
            paste(banner, t, 122 + 2, ty + 2, shadow, 0.6);
            paste(banner, t, 122, ty, colour);
            ty += 26;
        }
        writePng(path.join(libDir, "banner.png"), banner);
    }
}

// ---- startup sound: the first 3 seconds, faded out --------------------------------
{
    const src = path.join(libDir, "banner-source.wav");
    if (fs.existsSync(src)) {
        const wav = fs.readFileSync(src);
        let p = 12, fmt = null, data = null;
        while (p + 8 <= wav.length) {
            const id = wav.toString("latin1", p, p + 4), n = wav.readUInt32LE(p + 4);
            if (id === "fmt ") fmt = wav.subarray(p + 8, p + 8 + n);
            if (id === "data") data = wav.subarray(p + 8, p + 8 + n);
            p += 8 + n + (n & 1);
        }
        if (!fmt || !data || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(14) !== 16)
            throw new Error("banner-source.wav must be a plain 16-bit WAV file");
        const channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), frame = channels * 2;
        const frames = data.length / frame;
        // Skip silence at the start.
        let start = 0;
        while (start < frames && Math.abs(data.readInt16LE(start * frame)) < 300) start++;
        const SECONDS = 2.9, FADE = 0.6;
        const count = Math.min(frames - start, Math.floor(rate * SECONDS));
        const out = Buffer.alloc(count * frame);
        for (let f = 0; f < count; f++) {
            const left = (count - f) / rate, gain = left < FADE ? left / FADE : 1;
            for (let c = 0; c < channels; c++)
                out.writeInt16LE(Math.round(data.readInt16LE((start + f) * frame + c * 2) * gain), f * frame + c * 2);
        }
        const head = Buffer.alloc(44);
        head.write("RIFF", 0, "latin1");
        head.writeUInt32LE(36 + out.length, 4);
        head.write("WAVEfmt ", 8, "latin1");
        head.writeUInt32LE(16, 16);
        head.writeUInt16LE(1, 20);
        head.writeUInt16LE(channels, 22);
        head.writeUInt32LE(rate, 24);
        head.writeUInt32LE(rate * frame, 28);
        head.writeUInt16LE(frame, 32);
        head.writeUInt16LE(16, 34);
        head.write("data", 36, "latin1");
        head.writeUInt32LE(out.length, 40);
        fs.writeFileSync(path.join(libDir, "banner.wav"), Buffer.concat([head, out]));
        console.log(`Wrote library/banner.wav (${(count / rate).toFixed(1)} s, from ${(start / rate).toFixed(2)} s in).`);
    }
}

console.log("Wrote library/icon.png (48x48) and library/banner.png (256x128).");
