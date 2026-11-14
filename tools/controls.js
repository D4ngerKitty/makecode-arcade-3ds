#!/usr/bin/env node
// controls.js
// Button bindings: which 3DS button does what in a game.
//
//   node tools/controls.js <game folder>          show the game's bindings and
//                                                 what inputs the game reads
//   node tools/controls.js <game folder> --reset  write a fresh controls.json
//                                                 with suggested bindings
//
// Bindings live in <game folder>/controls.json. Edit it, then rebuild with
// node tools/build-3ds.js <game folder>. Example:
//
//   {
//     "buttons": {
//       "A": ["arcade:A", "z"],     <- 3DS A presses Arcade A and the Z key
//       "X": ["c"],
//       "L": []                     <- does nothing
//     }
//   }
//
// 3DS buttons:   UP DOWN LEFT RIGHT (D-pad and Circle Pad) A B X Y L R ZL ZR START
// Arcade inputs: arcade:A arcade:B arcade:up arcade:down arcade:left arcade:right arcade:menu
// Keyboard keys: letters, digits, Space, Enter, Shift, ArrowUp/Down/Left/Right, ...
// A 3DS button left out of the file keeps its default. SELECT always exits.

const fs = require("fs");
const path = require("path");

const BUTTONS = ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "X", "Y", "L", "R", "ZL", "ZR", "START"];
const ARCADE = { left: 1, up: 2, right: 3, down: 4, a: 5, b: 6, menu: 7 };
const DEFAULTS = {
    UP: ["arcade:up", "ArrowUp"], DOWN: ["arcade:down", "ArrowDown"],
    LEFT: ["arcade:left", "ArrowLeft"], RIGHT: ["arcade:right", "ArrowRight"],
    A: ["arcade:A", "Space"], B: ["arcade:B", "Enter"],
    X: [], Y: [], L: [], R: [], ZL: [], ZR: [], START: ["arcade:menu"],
};

const KEY_CODES = {
    space: 32, enter: 13, shift: 16, control: 17, alt: 18, tab: 9, backspace: 8, delete: 46,
    arrowleft: 37, arrowup: 38, arrowright: 39, arrowdown: 40, pageup: 33, pagedown: 34, end: 35, home: 36,
    "`": 192, "-": 189, "=": 187, "[": 219, "]": 221, "\\": 220, ";": 186, "'": 222, ",": 188, ".": 190, "/": 191,
};

// One binding ("arcade:A", "z", "Space") -> the number the runtime uses:
// negative for Arcade buttons, positive for keyboard key codes.
function actionCode(action) {
    const a = String(action).trim();
    const m = /^arcade:(.+)$/i.exec(a);
    if (m) {
        const id = ARCADE[m[1].toLowerCase()];
        if (!id) throw new Error(`controls.json: unknown Arcade button "${a}" (use arcade:A, B, up, down, left, right or menu)`);
        return -id;
    }
    const k = a.toLowerCase();
    if (KEY_CODES[k]) return KEY_CODES[k];
    if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
    if (a === " ") return 32;
    throw new Error(`controls.json: unknown key "${a}"`);
}

// controls.json -> the string compiled into the game ("A=-5,90;X=67").
function controlsString(projectDir) {
    const file = path.join(projectDir, "controls.json");
    if (!fs.existsSync(file)) return "";
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    return Object.entries(cfg.buttons || {}).map(([btn, actions]) => {
        if (!BUTTONS.includes(btn)) throw new Error(`controls.json: unknown 3DS button "${btn}"`);
        const list = [].concat(actions);
        if (list.length > 4) throw new Error(`controls.json: "${btn}" has more than 4 bindings`);
        return `${btn}=${list.map(actionCode).join(",")}`;
    }).join(";");
}

// ---- what does the game read? ---------------------------------------------------

function sourceFiles(projectDir) {
    const pxt = JSON.parse(fs.readFileSync(path.join(projectDir, "pxt.json"), "utf8"));
    return (pxt.files || []).filter(f => /\.ts$/.test(f) && !/\.g\.ts$/.test(f))
        .map(f => path.join(projectDir, f)).filter(f => fs.existsSync(f));
}

// Names as written in game code (browserEvents.ArrowUp) -> controls.json key names.
const KEY_NAMES = {
    Zero: "0", One: "1", Two: "2", Three: "3", Four: "4", Five: "5", Six: "6", Seven: "7", Eight: "8", Nine: "9",
    BackTick: "`", Hyphen: "-", Equals: "=", OpenBracket: "[", CloseBracket: "]", BackSlash: "\\",
    SemiColon: ";", Apostrophe: "'", Comma: ",", Period: ".", ForwardSlash: "/",
};
function scanGame(projectDir) {
    const keys = new Set(), arcade = new Set();
    let mouse = false;
    for (const f of sourceFiles(projectDir)) {
        const text = fs.readFileSync(f, "utf8");
        for (const m of text.matchAll(/browserEvents\.(\w+)\.(onEvent|isPressed|addEventListener|pauseUntil)/g)) {
            if (/^Mouse/.test(m[1])) mouse = true;
            else keys.add(KEY_NAMES[m[1]] || (m[1].length === 1 ? m[1].toLowerCase() : m[1]));
        }
        if (/browserEvents\.(onMouseMove|mouseX|mouseY|onWheel)/.test(text)) mouse = true;
        for (const m of text.matchAll(/controller\.(A|B|up|down|left|right|menu|anyButton)\b/g)) arcade.add(m[1]);
        if (/controller\.(moveSprite|dx|dy)\b/.test(text)) ["up", "down", "left", "right"].forEach(d => arcade.add(d));
    }
    return { keys: [...keys], arcade: [...arcade], mouse };
}

// A first guess: keep the defaults, then give every other key the game reads
// its own free button, most comfortable buttons first.
function suggest(projectDir) {
    const { keys } = scanGame(projectDir);
    const buttons = JSON.parse(JSON.stringify(DEFAULTS));
    const bound = new Set(Object.values(buttons).flat().map(a => String(a).toLowerCase()));
    const free = ["X", "Y", "R", "L", "ZR", "ZL"];
    const unbound = [];
    for (const key of keys) {
        if (bound.has(key.toLowerCase())) continue;
        try { actionCode(key); } catch (e) { unbound.push(key); continue; }
        // The usual "action" keys sit best on A and B, alongside the Arcade buttons.
        const preferred = /^(z|j)$/i.test(key) ? "A" : /^(x|k)$/i.test(key) ? "B" : null;
        if (preferred && buttons[preferred].length < 4) buttons[preferred].push(key);
        else if (free.length) buttons[free.shift()].push(key);
        else unbound.push(key);
        bound.add(key.toLowerCase());
    }
    return { buttons, unbound };
}

function describe(projectDir) {
    const { keys, arcade, mouse } = scanGame(projectDir);
    console.log("This game reads:");
    console.log("  Arcade buttons: " + (arcade.length ? arcade.join(", ") : "(none found)"));
    console.log("  Keyboard keys:  " + (keys.length ? keys.join(", ") : "(none)"));
    if (mouse) console.log("  Mouse:          yes (the touch screen is the mouse)");
    const file = path.join(projectDir, "controls.json");
    const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).buttons || {} : {};
    console.log("\nBindings" + (fs.existsSync(file) ? "" : " (defaults; no controls.json yet)") + ":");
    for (const b of BUTTONS) {
        const actions = current[b] !== undefined ? [].concat(current[b]) : DEFAULTS[b];
        console.log(`  ${b.padEnd(6)} ${actions.length ? actions.join(" + ") : "-"}`);
    }
    const all = new Set(BUTTONS.flatMap(b => (current[b] !== undefined ? [].concat(current[b]) : DEFAULTS[b]))
        .map(a => String(a).toLowerCase()));
    const missing = keys.filter(k => !all.has(k.toLowerCase()));
    if (missing.length) console.log("\nNot on any button yet: " + missing.join(", "));
}

// Writes controls.json with suggested bindings. Returns the path, or null if
// the game needs nothing beyond the defaults (and no file is wanted).
function writeSuggested(projectDir, always) {
    const { keys } = scanGame(projectDir);
    const { buttons, unbound } = suggest(projectDir);
    const needsFile = keys.some(k => !Object.values(DEFAULTS).flat().map(a => a.toLowerCase()).includes(k.toLowerCase()));
    if (!needsFile && !always) return null;
    const file = path.join(projectDir, "controls.json");
    const out = {
        "_help": "Which 3DS button does what. Each button lists up to 4 things: arcade:A/B/up/down/left/right/menu, " +
            "or keyboard keys like z, Space, Enter, ArrowUp. [] means nothing. Rebuild with tools/build-3ds.js after editing.",
        "_this_game_reads_keys": keys,
        buttons,
    };
    if (unbound.length) out["_not_on_any_button"] = unbound;
    fs.writeFileSync(file, JSON.stringify(out, null, 4) + "\n");
    return file;
}

module.exports = { controlsString, writeSuggested, describe, scanGame };

if (require.main === module) {
    const args = process.argv.slice(2);
    const reset = args.includes("--reset");
    const dir = args.filter(a => a !== "--reset")[0];
    if (!dir || !fs.existsSync(path.join(dir, "pxt.json"))) {
        console.error("Usage: node tools/controls.js <game folder> [--reset]");
        process.exit(1);
    }
    const projectDir = require("./paths.js").resolveGame(dir);
    if (reset) console.log("Wrote " + writeSuggested(projectDir, true) + "\n");
    describe(projectDir);
    console.log("\nEdit " + path.join(projectDir, "controls.json") +
        (fs.existsSync(path.join(projectDir, "controls.json")) ? "" : " (create it with --reset)") +
        ", then rebuild:  node tools/build-3ds.js " + dir);
}
