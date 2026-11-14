#!/usr/bin/env node
// patch-libs.js
// Makes speed-tuned copies of MakeCode's own built-in libraries for the 3DS
// build, in tools/3ds-libs/. get-game.js points the native build at these
// copies instead of the stock ones (the JavaScript build is left alone).
//
// Every patch must return exactly what the stock code returns - same values,
// same order - just with less work. If MakeCode changes the code a patch
// expects, this script stops with an error rather than guessing.
//
// Usage:  node tools/patch-libs.js      (get-game.js runs it when needed)

const fs = require("fs");
const os = require("os");
const path = require("path");

const cache = path.join(os.homedir(), ".pxt", "mkc-cache", "https_58__47__47_arcade.makecode.com-target.json");
const outRoot = path.join(__dirname, "3ds-libs");

// library -> file -> list of [what it is, stock code, replacement]
const PATCHES = {
    // Games can ask for a bigger screen (userconfig.ARCADE_SCREEN_WIDTH/HEIGHT).
    // The stock hardware build ignores that - "shim=TD_ID" makes these two
    // functions simply return the default 160x120 - because real Arcade
    // handhelds have a fixed screen. The 3DS can show other sizes, so let the
    // functions do what their code says: read the game's setting.
    "screen---linux": {
        "targetoverrides.ts": [
            ["honour the game's screen width",
                `    //% shim=TD_ID
    export function getScreenWidth(defl: number) {`,
                `    export function getScreenWidth(defl: number) {`],
            ["honour the game's screen height",
                `    //% shim=TD_ID
    export function getScreenHeight(defl: number) {`,
                `    export function getScreenHeight(defl: number) {`],
        ],
    },
    "game": {
        "tilemap.ts": [
            // tiles.getTilesByType() looked at every cell of the map through two
            // method calls and a bounds check per cell, and games call it many
            // times a frame. Now the map remembers where each kind of tile is
            // (found by reading its bytes directly, in the same column-by-column
            // order) and forgets that whenever a tile is changed. The result is
            // identical: a fresh array of fresh Locations in the same order.
            ["getTilesByType: remember tile positions until the map changes",
                `            let output: Location[] = [];
            for (let col = 0; col < this._map.width; ++col) {
                for (let row = 0; row < this._map.height; ++row) {
                    let currTile = this._map.getTile(col, row);
                    if (currTile === index) {
                        output.push(new Location(col, row, this));
                    }
                }
            }
            return output;
        }

        public sampleTilesByType(`,
                `            let output: Location[] = [];
            if ((index | 0) !== index) return output; // no tile has a fractional number
            const positions = this._map.__positionsOf(index);
            for (let i = 0; i < positions.length; ++i) {
                const p = positions[i];
                output.push(new Location(p >> 16, p & 0xffff, this));
            }
            return output;
        }

        public sampleTilesByType(`],
            ["TileMapData: position lookup with a cache",
                `        getTile(col: number, row: number) {
            if (this.isOutsideMap(col, row)) return 0;`,
                `        // 3DS: where each kind of tile is, as (col << 16 | row) in
        // column-by-column order. Thrown away whenever a tile changes.
        protected __positions: number[][];
        protected __positionsVersion: number;
        protected __version: number;

        __positionsOf(index: number): number[] {
            if (!this.__positions || this.__positionsVersion !== this.__version) {
                this.__positions = [];
                this.__positionsVersion = this.__version;
            }
            let found = this.__positions[index];
            if (!found) {
                found = [];
                const width = this._width;
                const height = this._height;
                const data = this.data;
                for (let col = 0; col < width; ++col) {
                    let offset = TM_DATA_PREFIX_LENGTH + col;
                    for (let row = 0; row < height; ++row) {
                        if (data.getUint8(offset) === index) {
                            found.push((col << 16) | row);
                        }
                        offset += width;
                    }
                }
                this.__positions[index] = found;
            }
            return found;
        }

        getTile(col: number, row: number) {
            if (this.isOutsideMap(col, row)) return 0;`],
            ["TileMapData.setTile: note that the map changed",
                `            this.data.setUint8(TM_DATA_PREFIX_LENGTH + (col | 0) + (row | 0) * this.width, tile);
        }`,
                `            this.data.setUint8(TM_DATA_PREFIX_LENGTH + (col | 0) + (row | 0) * this.width, tile);
            this.__version = (this.__version | 0) + 1;
        }`],
        ],
        "hitbox.ts": [
            ["declare the native helpers",
                `namespace game {
    export class Hitbox {`,
                `// 3DS: the doorway into native helpers in player/source/accel.cpp.
// MakeCode only lets game code call runtime functions it already knows, so
// these borrow three that do nothing on this platform: __accelCall(op, arg,
// image) runs helper number "op", and the two __accelResult functions read
// back what it worked out.
//% shim=multiplayer::postIcon
declare function __accelCall(op: number, arg: number, im: Image): void;
//% shim=Keyboard::getTextPromptSelectionStart
declare function __accelResult0(): number;
//% shim=Keyboard::getTextPromptSelectionEnd
declare function __accelResult1(): number;
//% shim=multiplayer::getCurrentImage
declare function __accelImage(): Image;

// Passes a number to the native helpers exactly (all 64 bits), for helpers
// that need a fractional value: __accelCall only carries whole numbers.
let __accelNoImage: Image = null;
function __accelSetNumber(value: number) {
    const b = control.createBuffer(8);
    b.setNumber(NumberFormat.Float64LE, 0, value);
    // (Native calls may not be given null for an image, so pass a tiny one.)
    if (!__accelNoImage) __accelNoImage = image.create(1, 1);
    __accelCall(0x3d50002, b.getNumber(NumberFormat.Int32LE, 0), __accelNoImage);
    __accelCall(0x3d50003, b.getNumber(NumberFormat.Int32LE, 4), __accelNoImage);
}

namespace game {
    export class Hitbox {`],
            // A sprite's hitbox is the smallest box around its visible pixels.
            // The stock code looks at every pixel of the image from game code.
            // The search for the four edges is now done by the 3DS runtime
            // (see player/source/accel.cpp). Same numbers
            // out, including for an empty image.
            ["calculateHitBox: native edge search",
                `        for (let c = 0, fxc = Fx.zeroFx8; c < i.width; c++, fxc = Fx.add(fxc, Fx.oneFx8)) {
            for (let r = 0, fxr = Fx.zeroFx8; r < i.height; r++, fxr = Fx.add(fxr, Fx.oneFx8)) {
                if (i.getPixel(c, r)) {
                    minX = Fx.min(minX, fxc);
                    minY = Fx.min(minY, fxr);
                    maxX = Fx.max(maxX, fxc);
                    maxY = Fx.max(maxY, fxr);
                }
            }
        }
`,
                `        // Helper 1: result 0 is (last << 16 | first) column with a visible
        // pixel, or -1 for an empty image; result 1 is the same for rows.
        __accelCall(0x3d50001, 0, i);
        const boundsX = __accelResult0();
        if (boundsX >= 0) {
            const boundsY = __accelResult1();
            minX = Fx8(boundsX & 0xffff);
            maxX = Fx8(boundsX >> 16);
            minY = Fx8(boundsY & 0xffff);
            maxY = Fx8(boundsY >> 16);
        }
`],
        ],
    },
};

// Patches for GitHub extensions, by repository ("owner/name"). An extension
// is patched only if every patch applies; otherwise the game is built with the
// extension unchanged, so an unknown version can never break a game.
const EXTENSION_PATCHES = {
    "woofwoofcodes/lanterns": {
        "Lanterns.ts": [
            // Flickering lights ("shiver") redrew every ring row of every light
            // each frame in game code, with fractional numbers - each needing
            // slow conversions and memory - about 90 million instructions a
            // frame in RED-LINE. Each row is now one native call doing the same
            // steps with the same random numbers in the same order.
            // The game changes a light's size every frame ("breathing"), and each
            // change redrew the whole light's rings in game code, again with
            // fractional numbers. Each ring row is now one native call.
            ["circle light ring rows: native", "        setup(lightMap: Image) {\n            const halfh = this.width;\n            const cx = halfh + this._shiver\n            const cy = halfh\n\n            let prev: number;\n            let offset: number;\n            let band: number;\n\n            // Go over each row and light the colors\n            for (let y = 0; y < halfh; y++) {\n                band = this.rings;\n                prev = 0;\n                offset = this.offsetTable[y * this.rings + band - 1]\n\n                // Darken each concentric circle by remapping the colors\n                while (band >= 0) {\n                    offset = this.offsetTable[y * this.rings + band - 1]\n                    //if (offset) {\n                    //    offset += Math.idiv(Math.randomRange(-this._shiver * 5, this._shiver * 5), 10)\n                    //}\n\n                    // We reflect the circle-quadrant horizontally and vertically\n                    changeRowLightLevel(lightMap, cx + offset, cy + y + 1, prev - offset, band)\n                    changeRowLightLevel(lightMap, cx - prev, cy + y + 1, prev - offset, band)\n                    changeRowLightLevel(lightMap, cx + offset, cy - y, prev - offset, band)\n                    changeRowLightLevel(lightMap, cx - prev, cy - y, prev - offset, band)\n\n                    if (band == 0) {\n                        changeRowLightLevel(lightMap, cx, cy + y + 1, prev, 0)\n                        changeRowLightLevel(lightMap, cx - prev, cy + y + 1, prev, 0)\n                        changeRowLightLevel(lightMap, cx, cy - y, prev, 0)\n                        changeRowLightLevel(lightMap, cx - prev, cy - y, prev, 0)\n                    }\n\n                    prev = offset;\n                    band--;\n                }\n            }\n        }", "        setup(lightMap: Image) {\n            const halfh = this.width;\n            const cx = halfh + this._shiver\n            const cy = halfh\n\n            // 3DS: each ring row (all the mirrored row updates) is done\n            // natively, same steps (see player/source/accel.cpp).\n            __accelSetNumber(cx);\n            __accelCall(0x3d50005, 0, lightMap);\n            __accelSetNumber(cy);\n            __accelCall(0x3d50005, 1, lightMap);\n\n            let prev: number;\n            let offset: number;\n            let band: number;\n\n            // Go over each row and light the colors\n            for (let y = 0; y < halfh; y++) {\n                band = this.rings;\n                prev = 0;\n                offset = this.offsetTable[y * this.rings + band - 1]\n\n                // Darken each concentric circle by remapping the colors\n                while (band >= 0) {\n                    offset = this.offsetTable[y * this.rings + band - 1]\n                    __accelCall(0x3d50007, (prev & 0xff) | ((offset & 0xff) << 8) | ((band & 0x3f) << 16) | (y << 22), lightMap)\n                    prev = offset;\n                    band--;\n                }\n            }\n        }"],
            ["circle light flicker rows: native", "                const halfh = this.width;\n                const cx = halfh + this._shiver\n                const cy = halfh\n\n                let prev: number;\n                let offset: number;\n                let band: number;\n                for (let y = 0; y < halfh; y++) {\n                    band = this.rings;\n                    prev = 0;\n                    offset = this.offsetTable[y * this.rings + band - 1]\n\n                    // Darken each concentric circle by remapping the colors\n                    while (band >= 0) {\n                        offset = this.offsetTable[y * this.rings + band - 1]\n                        if (prev) {\n                            let rand = Math.randomRange(0, this._shiver)\n\n                            // We reflect the circle-quadrant horizontally and vertically\n                            changeRowLightLevel(temp, cx + prev, cy + y + 1, rand, band) // bottom right\n                            changeRowLightLevel(temp, cx - prev - rand, cy + y + 1, rand, band) // bottom left\n                            changeRowLightLevel(temp, cx + prev, cy - y, rand, band) // top right\n                            changeRowLightLevel(temp, cx - prev - rand, cy - y, rand, band) // top left\n\n                        }\n\n                        prev = offset;\n                        band--;\n                    }\n                }", "                const halfh = this.width;\n                const cx = halfh + this._shiver\n                const cy = halfh\n\n                // 3DS: each flickering ring row (the random width and the four\n                // mirrored rows) is done natively, with the same random numbers\n                // in the same order (see player/source/accel.cpp).\n                __accelSetNumber(cx);\n                __accelCall(0x3d50005, 0, temp);\n                __accelSetNumber(cy);\n                __accelCall(0x3d50005, 1, temp);\n                __accelSetNumber(this._shiver);\n                __accelCall(0x3d50005, 2, temp);\n\n                let prev: number;\n                let offset: number;\n                let band: number;\n                for (let y = 0; y < halfh; y++) {\n                    band = this.rings;\n                    prev = 0;\n                    offset = this.offsetTable[y * this.rings + band - 1]\n\n                    // Darken each concentric circle by remapping the colors\n                    while (band >= 0) {\n                        offset = this.offsetTable[y * this.rings + band - 1]\n                        if (prev) {\n                            __accelCall(0x3d50006, prev | (band << 8) | (y << 16), temp)\n                        }\n\n                        prev = offset;\n                        band--;\n                    }\n                }"],
        ],
    },
    "jwunderl/pxt-scaling": {
        "rot.ts": [
            // scaling.rot() at angles other than 0/90/180/270 rebuilt and
            // rotated the image pixel by pixel in game code (Rhombus Rush does
            // this every frame on its title screen: ~150 million instructions
            // a frame). The same steps - 3x smoothing enlargement, rotation
            // with the same trigonometry, most-common-colour shrink - now run
            // natively (player/source/accel.cpp) and give the same pixels.
            ["rotSprite: native",
                `    function rotSprite(im: Image, deg: number) {
        let base = im;`,
                `    function rotSprite(im: Image, deg: number) {
        // 3DS: done natively, same result (see player/source/accel.cpp).
        __accelSetNumber(deg);
        __accelCall(0x3d50004, 0, im);
        return __accelImage();
    }

    function rotSprite_original(im: Image, deg: number) {
        let base = im;`],
        ],
    },
};

// Makes patched copies of the game's GitHub extensions that have patches.
// links: { name: folder } from mkc.json. Returns { name: patched folder }.
function patchExtensions(links, projectDir) {
    const out = {};
    for (const [name, rel] of Object.entries(links || {})) {
        const dir = path.resolve(projectDir, rel);
        const m = /^([^_]+)__(.+)__[^_]*$/.exec(path.basename(dir));
        const patches = m && EXTENSION_PATCHES[m[1] + "/" + m[2]];
        if (!patches || !fs.existsSync(path.join(dir, "pxt.json"))) continue;
        const copy = path.join(outRoot, "ext", path.basename(dir));
        fs.rmSync(copy, { recursive: true, force: true });
        fs.mkdirSync(copy, { recursive: true });
        let ok = true;
        for (const f of fs.readdirSync(dir)) {
            const src = path.join(dir, f);
            if (!fs.statSync(src).isFile()) continue;
            let text = fs.readFileSync(src, "utf8");
            for (let [what, from, to] of patches[f] || []) {
                // Line endings and spaces at the ends of lines are ignored.
                const norm = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
                from = from.replace(/[ \t]+\n/g, "\n");
                if (norm.split(from).length !== 2) {
                    console.log(`Note: ${m[1]}/${m[2]} (${f}) is a version the speed-up does not know; using it unchanged.`);
                    ok = false;
                    break;
                }
                text = norm.replace(from, () => to);
            }
            fs.writeFileSync(path.join(copy, f), text);
        }
        if (ok) out[name] = copy;
    }
    return out;
}

function patchLibs() {
    if (!fs.existsSync(cache))
        throw new Error("MakeCode target cache not found. Build any game with mkc first.");
    const target = JSON.parse(fs.readFileSync(cache, "utf8"));
    const links = {};
    for (const [lib, files] of Object.entries(PATCHES)) {
        const pkg = target.bundledpkgs[lib];
        if (!pkg) throw new Error(`Library "${lib}" is not in this MakeCode version.`);
        const outDir = path.join(outRoot, lib);
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.mkdirSync(outDir, { recursive: true });
        for (let [name, text] of Object.entries(pkg)) {
            for (let [what, from, to] of files[name] || []) {
                // Line endings and spaces at the ends of lines are ignored.
                const norm = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
                from = from.replace(/[ \t]+\n/g, "\n");
                if (norm.split(from).length !== 2)
                    throw new Error(`${lib}/${name}: cannot apply "${what}" - the stock code has changed. Update tools/patch-libs.js.`);
                text = norm.replace(from, () => to);
            }
            fs.writeFileSync(path.join(outDir, name), text);
        }
        links[lib] = outDir;
    }
    fs.writeFileSync(path.join(outRoot, "VERSION.txt"), `MakeCode Arcade target ${target.versions.target}\n`);
    return links; // library name -> folder
}

module.exports = { patchLibs, patchExtensions };

if (require.main === module) {
    const links = patchLibs();
    for (const [lib, dir] of Object.entries(links)) console.log(`Patched ${lib} -> ${dir}`);
}
