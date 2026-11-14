// player-build.js
// Shared by build-3ds.js and test-qemu.js: compiles the MakeCode runtime
// (player/) for one platform and links it with a game built by get-game.js.
//
// Two ways to build:
//  - with devkitPro installed: the runtime is compiled from source here.
//  - with the bundled toolchain/ folder (made by tools/make-toolchain.js):
//    the runtime comes ready-built, and only the assembler and linker are
//    used, so nothing needs installing. Used automatically when devkitPro
//    is missing; MCA3DS_TOOLCHAIN=bundled or =devkitpro forces one.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const playerDir = path.join(root, "player");
const toolchainDir = path.join(root, "toolchain");

function fail(msg) {
    console.error("\nERROR: " + msg);
    process.exit(1);
}

const exe = process.platform === "win32" ? ".exe" : "";
const dkp = [process.env.DEVKITPRO, "C:/devkitPro", "/opt/devkitpro"]
    .filter(p => p && fs.existsSync(path.join(p, "devkitARM", "bin", "arm-none-eabi-gcc" + exe)))[0] || null;
const haveBundled = fs.existsSync(path.join(toolchainDir, "runtime", "runtime.json"));
const forced = process.env.MCA3DS_TOOLCHAIN;
const mode = forced === "bundled" ? "bundled" : forced === "devkitpro" ? "devkitpro" : dkp ? "devkitpro" : haveBundled ? "bundled" : null;

// devkitPro programs (only in devkitPro mode).
const bin = name => {
    if (!dkp) fail("devkitPro was not found. Install it with the 3DS tools.");
    return path.join(dkp, "devkitARM", "bin", "arm-none-eabi-" + name + exe);
};
const tool = name => path.join(dkp || "", "tools", "bin", name + exe);
const ctru = path.join(dkp || "", "libctru");

// The assembler and linker for the current mode.
function assembler() {
    return mode === "bundled" ? path.join(toolchainDir, "bin", "as" + exe) : bin("as");
}
function linker() {
    return mode === "bundled" ? path.join(toolchainDir, "bin", "ld" + exe) : bin("ld");
}

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true, ...opts });
    if (r.error) fail(`Could not run ${cmd}: ${r.error.message}`);
    if (r.status !== 0) {
        process.stderr.write((r.stdout || "") + (r.stderr || ""));
        fail(`${path.basename(cmd)} failed.`);
    }
    return r.stdout || "";
}

const PLATFORMS = {
    "3ds": {
        arch: ["-march=armv6k", "-mtune=mpcore", "-mfloat-abi=hard", "-mtp=soft"],
        defines: ["-D__3DS__"],
        includes: () => [path.join(ctru, "include")],
        // Everything in player/source.
        sourceFilter: () => true,
        extraSourceDirs: [],
        skipDirs: [],
        link: () => ["-specs=3dsx.specs", "-L" + path.join(ctru, "lib"), "-lctru", "-lm"],
    },
    "qemu": {
        arch: ["-march=armv6k", "-mtune=mpcore", "-mfloat-abi=hard"],
        defines: ["-DPXT_QEMU"],
        includes: () => [],
        // Everything except the 3DS hardware files (plat3ds.cpp, sound3ds.cpp).
        sourceFilter: f => !/3ds\.cpp$/.test(f) && f !== "hbldr.cpp",
        extraSourceDirs: ["qemu"],
        skipDirs: [],
        link: () => ["--specs=rdimon.specs", "-Wl,--entry=pxt_qemu_boot", "-lm"],
    },
};

// Compiles the runtime from source (devkitPro mode); returns the object files
// in link order. Only files that changed are recompiled.
function compileRuntime(platformName) {
    const plat = PLATFORMS[platformName];
    const buildDir = path.join(playerDir, "build", platformName);
    fs.mkdirSync(buildDir, { recursive: true });
    if (!fs.existsSync(path.join(playerDir, "pxt", "base", "pxtbase.h"))) {
        console.log("Extracting the MakeCode runtime sources...");
        run(process.execPath, [path.join(__dirname, "extract-runtime.js")], { stdio: "inherit" });
    }

    const includeDirs = ["source/include", "pxt/base", "pxt/mixer"].map(d => path.join(playerDir, d));
    // -fno-strict-aliasing: the runtime reads the same memory through different
    // pointer types all over (it was written for older compilers that let that
    // slide); without this flag current GCC miscompiles it.
    const cxxflags = [...plat.arch, "-O3", "-g", "-fno-strict-aliasing", "-ffp-contract=off", "-std=gnu++14", "-fno-rtti", "-fno-exceptions",
        "-fwrapv", "-fno-threadsafe-statics", "-ffunction-sections", "-mword-relocations", "-w",
        ...plat.defines, ...includeDirs.concat(plat.includes()).map(d => "-I" + d)];

    const sources = [];
    for (const dir of ["pxt/base", "pxt/screen", "pxt/mixer", "pxt/shader", "source", ...plat.extraSourceDirs]) {
        if (plat.skipDirs.includes(dir)) continue;
        const full = path.join(playerDir, dir);
        for (const f of fs.readdirSync(full))
            if (/\.(cpp|s)$/.test(f) && (dir !== "source" || plat.sourceFilter(f))) sources.push(path.join(full, f));
    }
    let newestHeader = fs.statSync(__filename).mtimeMs; // flags live in this file
    for (const dir of includeDirs)
        for (const f of fs.readdirSync(dir))
            if (/\.h$/.test(f)) newestHeader = Math.max(newestHeader, fs.statSync(path.join(dir, f)).mtimeMs);

    const objects = [];
    let compiled = 0;
    for (const src of sources) {
        const obj = path.join(buildDir, path.basename(src).replace(/\.(cpp|s)$/, ".o"));
        objects.push(obj);
        const srcTime = Math.max(fs.statSync(src).mtimeMs, newestHeader);
        if (fs.existsSync(obj) && fs.statSync(obj).mtimeMs > srcTime) continue;
        console.log("Compiling " + path.relative(playerDir, src));
        if (src.endsWith(".s")) run(bin("gcc"), [...plat.arch, "-c", src, "-o", obj]);
        else run(bin("g++"), [...cxxflags, "-c", src, "-o", obj]);
        compiled++;
    }
    if (!compiled) console.log("Runtime is up to date.");
    return objects;
}

// The runtime's symbols: which names it defines, and for each C++ function
// name ("numops::adds") its symbol. Read with devkitPro's nm.
function runtimeSymbols(objects) {
    const mangled = run(bin("nm"), ["--defined-only", ...objects]).split(/\r?\n/);
    const demangled = run(bin("nm"), ["--defined-only", "-C", ...objects]).split(/\r?\n/);
    const byName = {};
    const defined = [];
    for (let i = 0; i < mangled.length; i++) {
        const m = /^[0-9a-f]+ [A-Za-z] (\S+)$/.exec(mangled[i]);
        const d = /^[0-9a-f]+ [A-Za-z] (.+)$/.exec(demangled[i] || "");
        if (!m || !d) continue;
        defined.push(m[1]);
        const name = d[1].replace(/\(.*$/, "").trim();
        if (!(name in byName)) byName[name] = m[1];
    }
    return { defined, byName };
}

// Button bindings come from <project>/controls.json (see tools/controls.js).
function readControls(projectDir) {
    let controls;
    try {
        controls = require("./controls.js").controlsString(projectDir);
    } catch (e) {
        fail(e.message);
    }
    console.log(controls ? "Controls: " + controls : "No controls.json in the project: using default controls.");
    return controls;
}

// The controls string as a tiny assembly file:
//   const char *pxt3ds_controls = "...";
function controlsAssembly(controls) {
    const escaped = controls.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return [
        "@ Generated by tools/player-build.js",
        "    .section .rodata.pxt3ds_controls_text,\"a\"",
        ".Ltext:",
        `    .asciz "${escaped}"`,
        "    .section .data.pxt3ds_controls,\"aw\"",
        "    .balign 4",
        "    .global pxt3ds_controls",
        "pxt3ds_controls:",
        "    .word .Ltext",
        "",
    ].join("\n");
}

// The link step for the 3DS, as the devkitPro compiler driver does it for
// "-specs=3dsx.specs" (see tools/make-toolchain.js), with the files in `lib`.
function bundledLinkArgs(lib, inputs, out, map) {
    const L = f => path.join(lib, f);
    return ["--defsym=__sync_synchronize=__sync_synchronize_dmb", "-X", "-T", L("3dsx.ld"), "-d", "--emit-relocs",
        "--use-blx", "--gc-sections", "-Map", map, "-o", out,
        L("3dsx_crt0.o"), L("crti.o"), L("crtbegin.o"), "-L" + lib,
        ...inputs,
        "-lctru", "-lstdc++", "-lm", "--start-group", "-lgcc", "-lg", "-lc", "-lsysbase", "--end-group",
        L("crtend.o"), L("crtn.o")];
}

// Builds <project>/built/<platform>/<name>.elf and returns its path without ".elf".
function buildPlayer(projectDir, platformName) {
    if (!mode) fail("Neither devkitPro nor the bundled toolchain folder was found.");
    if (mode === "bundled" && platformName !== "3ds") fail("Only 3DS builds are possible without devkitPro.");
    const gameDir = path.join(projectDir, "built", "3ds"); // output of get-game.js
    const gameObj = path.join(gameDir, "game.o");
    if (!fs.existsSync(gameObj))
        fail(`${projectDir} has not been built yet. Run tools/get-game.js on it first.`);
    const outDir = path.join(projectDir, "built", platformName);
    fs.mkdirSync(outDir, { recursive: true });

    // ---- 1. The runtime --------------------------------------------------------
    let objects, symbols;
    if (mode === "bundled") {
        const info = JSON.parse(fs.readFileSync(path.join(toolchainDir, "runtime", "runtime.json"), "utf8"));
        objects = info.objects.map(o => path.join(toolchainDir, "runtime", o));
        symbols = info;
        console.log("Using the ready-built runtime (no devkitPro needed).");
    } else {
        objects = compileRuntime(platformName);
        symbols = runtimeSymbols(objects);
    }

    // ---- 2. Match the game's runtime calls to the runtime's functions ----------
    // The game asks for e.g. "numops::adds" (symbol pxt_numops__adds). Find the
    // C++ function with that name in the runtime and point one at the other.
    const haveSymbol = new Set(symbols.defined);
    const imports = JSON.parse(fs.readFileSync(path.join(gameDir, "imports.json"), "utf8"));
    const missing = [];
    const ldLines = ["/* Generated by tools/player-build.js */"];
    for (const [name, symbol] of Object.entries(imports)) {
        if (haveSymbol.has(symbol)) continue; // defined directly under that name
        const target = symbols.byName[name];
        if (target) ldLines.push(`${symbol} = ${target};`);
        else missing.push(name);
    }
    if (missing.length)
        fail("This game uses features the 3DS runtime does not have yet:\n  " + missing.join("\n  "));
    const symsPath = path.join(outDir, "runtime-syms.ld");
    fs.writeFileSync(symsPath, ldLines.join("\n") + "\n");

    // ---- 3. Controls, then link --------------------------------------------------
    const controlsSrc = path.join(outDir, "controls.s");
    const controlsObj = path.join(outDir, "controls.o");
    fs.writeFileSync(controlsSrc, controlsAssembly(readControls(projectDir)));
    run(assembler(), ["-march=armv6k", "-mfloat-abi=hard", "-o", controlsObj, controlsSrc]);

    const outBase = path.join(outDir, path.basename(projectDir));
    console.log("Linking...");
    if (mode === "bundled") {
        run(linker(), bundledLinkArgs(path.join(toolchainDir, "lib"), [...objects, controlsObj, gameObj, symsPath],
            outBase + ".elf", outBase + ".map"));
    } else {
        const plat = PLATFORMS[platformName];
        run(bin("g++"), ["-g", ...plat.arch, "-Wl,--gc-sections", "-Wl,-Map," + outBase + ".map",
            ...objects, controlsObj, gameObj, symsPath, ...plat.link(), "-o", outBase + ".elf"]);
    }
    return outBase;
}

module.exports = { buildPlayer, compileRuntime, runtimeSymbols, bundledLinkArgs, assembler, run, fail, bin, tool, ctru, root,
    mode, dkp, toolchainDir };
