#!/usr/bin/env node
// get-game.js
// One command: fetch a MakeCode Arcade game, fetch its extensions, and build it.
//
// Usage:
//   node tools/get-game.js <share link | GitHub URL | project folder> [--name <folder>] [--no-build]
//
// Examples:
//   node tools/get-game.js https://arcade.makecode.com/S12345-67890-12345-67890
//   node tools/get-game.js https://makecode.com/_abc123XYZ
//   node tools/get-game.js https://github.com/owner/my-game
//   node tools/get-game.js frosthaven            (rebuild a project you already have)
//
// Output (inside the project folder):
//   built/binary.js        JavaScript build (for the PC test harness)
//   built/rpi/binary.asm   native ARM build, as written by MakeCode
//   built/3ds/game.o       the same code assembled by devkitARM, ready to link
//                          against the 3DS runtime
//   built/3ds/imports.json the runtime functions the game needs
//
// Needs: node, devkitPro (devkitARM) and mkc (npm install -g makecode) on your PATH, plus internet.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveDeps, downloadRepo } = require("./resolve-deps.js");
const { translate } = require("./asm2gas.js");

const { root, gamesDir, depsDir, resolveGame } = require("./paths.js");

const args = process.argv.slice(2);
function flag(name) {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
}
function option(name) {
    const i = args.indexOf(name);
    if (i < 0) return "";
    const v = args[i + 1] || "";
    args.splice(i, 2);
    return v;
}
const noBuild = flag("--no-build");
const stockLibs = flag("--stock-libs");
const wantedName = option("--name");
const source = args[0];
if (!source) {
    console.error("Usage: node tools/get-game.js <share link | GitHub URL | project folder> [--name <folder>] [--no-build]");
    process.exit(1);
}

// Runs MakeCode's command-line compiler ("mkc"), shows its output, and
// returns everything it printed. Uses the copy bundled with the app (in
// mkc/makecode next to tools/) when there is one, else the installed one.
function mkc(mkcArgs, cwd) {
    const bundled = path.join(root, "mkc", "makecode", "makecode");
    let r;
    if (fs.existsSync(bundled)) {
        r = spawnSync(process.execPath, [bundled, ...mkcArgs], { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 28 });
    } else {
        // The installed mkc is a .cmd script on Windows, which needs a shell.
        const quote = a => /[\s&|<>^"]/.test(a) ? '"' + a.replace(/"/g, "") + '"' : a;
        r = spawnSync(["mkc", ...mkcArgs.map(quote)].join(" "),
            { cwd, shell: true, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 28 });
    }
    if (r.error) console.log("Could not run the MakeCode compiler: " + r.error.message);
    const out = (r.stdout || "") + (r.stderr || "");
    process.stdout.write(out);
    return { ok: r.status === 0, out };
}

function slug(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "game";
}

// New games go in games/, under a name not already taken.
function freeFolder(name) {
    fs.mkdirSync(gamesDir, { recursive: true });
    let dir = path.join(gamesDir, name);
    for (let n = 2; fs.existsSync(dir); n++) dir = path.join(gamesDir, `${name}-${n}`);
    return dir;
}

function fail(msg) {
    console.error("\nERROR: " + msg);
    process.exit(1);
}

async function main() {

// ---- 1. Get the project source into a folder ------------------------------

let projectDir;
const github = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/?#]+))?\/?(?:[?#].*)?$/.exec(source);

if (fs.existsSync(path.join(resolveGame(source), "pxt.json"))) {
    projectDir = resolveGame(source);
    console.log(`Using existing project: ${projectDir}`);
} else if (github) {
    const [, owner, repo, branch] = github;
    projectDir = freeFolder(wantedName || slug(repo));
    console.log(`Downloading ${owner}/${repo} into ${projectDir}`);
    await downloadRepo(owner, repo, branch || "", projectDir);
    if (!fs.existsSync(path.join(projectDir, "pxt.json"))) fail("That repository is not a MakeCode project (no pxt.json).");
} else if (/^https?:\/\//.test(source)) {
    // A share link. mkc downloads into the current folder, so use a temporary
    // one and rename it once we know the game's name.
    fs.mkdirSync(gamesDir, { recursive: true });
    const tmp = path.join(gamesDir, `_download_${Date.now()}`);
    fs.mkdirSync(tmp);
    console.log(`Downloading ${source}`);
    const ok = mkc(["download", source], tmp).ok && fs.existsSync(path.join(tmp, "pxt.json"));
    if (!ok) {
        fs.rmSync(tmp, { recursive: true, force: true });
        fail("Could not download that link. Check it is a MakeCode Arcade share link.");
    }
    const pxt = JSON.parse(fs.readFileSync(path.join(tmp, "pxt.json"), "utf8"));
    projectDir = freeFolder(wantedName || slug(pxt.name));
    fs.renameSync(tmp, projectDir);
    console.log(`Saved "${pxt.name}" to ${projectDir}`);
} else {
    fail(`"${source}" is not a link or a folder containing pxt.json.`);
}

// ---- 2. Fetch the extensions it depends on --------------------------------
// GitHub extensions are cloned into _deps/ and linked in mkc.json.
// Built-in ("*") and shared-script ("pub:...") extensions are fetched by mkc itself.

console.log("\nFetching extensions...");
await resolveDeps(projectDir, depsDir);

if (noBuild) return;

// ---- 3. Build --------------------------------------------------------------

console.log("\nBuilding JavaScript version (for PC testing)...");
const js = mkc(["build", "-j"], projectDir);
if (!js.ok) fail("The game does not compile. Fix the errors above first.");

console.log("\nBuilding native ARM version (for the 3DS)...");
const asmPath = path.join(projectDir, "built", "rpi", "binary.asm");
const before = fs.existsSync(asmPath) ? fs.statSync(asmPath).mtimeMs : 0;
// The native build gets one extra extension, tools/3ds-compat, which fills in
// hardware APIs that this build target lacks. It goes in a separate config so
// the project's own files and the JavaScript build stay untouched.
const pxtJson = JSON.parse(fs.readFileSync(path.join(projectDir, "pxt.json"), "utf8"));
const mkc3ds = JSON.parse(fs.readFileSync(path.join(projectDir, "mkc.json"), "utf8"));
const compatDir = path.join(__dirname, "3ds-compat");
const relLink = dir => path.relative(projectDir, dir).split(path.sep).join("/");
mkc3ds.links = Object.assign({}, mkc3ds.links, { "3ds-compat": relLink(compatDir) });
// Speed-tuned copies of MakeCode's built-in libraries (see patch-libs.js).
// --stock-libs builds with the unmodified libraries instead, for comparison.
if (!stockLibs) {
    for (const [lib, dir] of Object.entries(require("./patch-libs.js").patchLibs()))
        mkc3ds.links[lib] = relLink(dir);
    const ext = require("./patch-libs.js").patchExtensions(mkc3ds.links, projectDir);
    for (const [name, dir] of Object.entries(ext)) mkc3ds.links[name] = relLink(dir);
    console.log("Using speed-tuned libraries: " + Object.keys(require("./patch-libs.js").patchLibs()).concat(Object.keys(ext)).join(", "));
}
mkc3ds.overrides = Object.assign({}, mkc3ds.overrides, {
    // This address is never downloaded: the link above points at the local folder.
    dependencies: Object.assign({}, pxtJson.dependencies, { "3ds-compat": "github:makecode-3ds/3ds-compat#v1.0.0" }),
});
fs.writeFileSync(path.join(projectDir, "mkc-3ds.json"), JSON.stringify(mkc3ds, null, 4) + "\n");
const native = mkc(["build", "--hw", "rpi", "-c", "mkc-3ds.json"], projectDir);
const asmFresh = fs.existsSync(asmPath) && fs.statSync(asmPath).mtimeMs > before;

// MakeCode refuses to finish games bigger than a real Arcade handheld can hold
// ("program too large"), but it has already written the assembly by then, and
// that is all the 3DS compile step needs. Any other error is a real failure.
const tooLarge = /program too large/.test(native.out);
const otherErrors = native.out.split(/\r?\n/).filter(l => /error TS\d+/.test(l) && !/program too large/.test(l));
if (!asmFresh || otherErrors.length || (!native.ok && !tooLarge))
    fail("The native build failed. See the errors above.");

// Games that read keyboard keys need those keys put on 3DS buttons. Write a
// suggested controls.json the first time; after that it is the user's to edit.
if (!fs.existsSync(path.join(projectDir, "controls.json"))) {
    const made = require("./controls.js").writeSuggested(projectDir, false);
    if (made) console.log("\nThis game reads keyboard keys; suggested button bindings written to " + made);
}

// ---- 4. Assemble for the 3DS ------------------------------------------------

console.log("\nAssembling for the 3DS...");
const outDir = path.join(projectDir, "built", "3ds");
fs.mkdirSync(outDir, { recursive: true });
const { gas, imports } = translate(fs.readFileSync(asmPath, "utf8"));
fs.writeFileSync(path.join(outDir, "game.s"), gas);
fs.writeFileSync(path.join(outDir, "imports.json"),
    JSON.stringify(Object.fromEntries([...imports].sort()), null, 2) + "\n");

// devkitPro's assembler, or the bundled one in toolchain/ (see player-build.js).
const playerBuild = require("./player-build.js");
if (!playerBuild.mode) fail("Neither devkitPro nor the bundled toolchain folder was found.");
const objPath = path.join(outDir, "game.o");
const as = spawnSync(playerBuild.assembler(), ["-o", objPath, path.join(outDir, "game.s")], { encoding: "utf8", windowsHide: true });
process.stdout.write((as.stdout || "") + (as.stderr || ""));
if (as.status !== 0) fail("Assembling for the 3DS failed. See the errors above.");

const info = /generated code sizes \(bytes\): (\d+)/.exec(fs.readFileSync(asmPath, "utf8").slice(0, 4000));
console.log("\nDone.");
console.log(`  Project:        ${projectDir}`);
console.log(`  JavaScript:     ${path.join(projectDir, "built", "binary.js")}`);
console.log(`  3DS object:     ${objPath}`);
console.log(`  Runtime needs:  ${imports.size} functions (${path.join(outDir, "imports.json")})`);
if (info) console.log(`  Compiled size:  ${(Number(info[1]) / 1024).toFixed(0)} KB`);
if (tooLarge) console.log("  (Too big for a real Arcade handheld - that is fine for the 3DS.)");

}

main().catch(e => fail(e.message));
