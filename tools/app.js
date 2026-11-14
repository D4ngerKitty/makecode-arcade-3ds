#!/usr/bin/env node
// app.js - the MakeCode 3DS app (start it with "MakeCode 3DS.bat").
//
// A small server on this PC with a page in your web browser for adding and
// editing games, and a Wi-Fi link to the 3DS library:
//
//   http://localhost:8380      the page (only from this PC)
//   /api/...                   what the page uses (only from this PC)
//   /sync/...                  the 3DS library downloads games from here
//                              ("Get games from PC" in the library)
//
// While it runs it announces itself on the home network once a second
// (UDP broadcast "MCA3DS 8380" to port 47900) so the 3DS can find it.
// Only the finished library folder is ever sent to the 3DS.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dgram = require("dgram");
const { spawn } = require("child_process");
const { installGame, libraryOut } = require("./library-install.js");

// Started from "MakeCode 3DS.exe" (tools/launcher/main.js): open our own
// window, and write what would go to the console to app.log instead.
const WINDOW_MODE = process.env.MCA3DS_WINDOW === "1";
if (WINDOW_MODE) {
    const logFile = path.join(path.resolve(__dirname, ".."), "app.log");
    fs.writeFileSync(logFile, `MakeCode 3DS started ${new Date().toString()}\n`);
    const write = (...a) => fs.appendFileSync(logFile, a.map(String).join(" ") + "\n");
    console.log = write;
    console.error = write;
    process.on("uncaughtException", e => write("ERROR: " + (e && e.stack || e)));
}

const PORT = Number(process.env.MCA3DS_PORT) || 8380; // MCA3DS_PORT: for testing a second copy
const ANNOUNCE_PORT = 47900;
const root = path.resolve(__dirname, "..");

// ---- games --------------------------------------------------------------------

const { gamesDir, gameFolders } = require("./paths.js");

function gameInfo(id) {
    const dir = path.join(gamesDir, id);
    const lib = path.join(dir, "library.json");
    let info = {};
    if (fs.existsSync(lib)) info = JSON.parse(fs.readFileSync(lib, "utf8"));
    else {
        const pxt = JSON.parse(fs.readFileSync(path.join(dir, "pxt.json"), "utf8"));
        info = { name: pxt.name || id, author: "", version: pxt.version || "", tags: [], description: pxt.description || "" };
    }
    return {
        id,
        name: info.name || id,
        author: [].concat(info.author || []).join(", "),
        version: info.version || "",
        tags: [].concat(info.tags || []),
        description: info.description || "",
        hasArt: fs.existsSync(path.join(dir, "art.png")) || fs.existsSync(path.join(root, "game art", id + ".png")),
        built: fs.existsSync(path.join(dir, "built", "3ds", id + ".3dsx")),
    };
}

function saveInfo(id, body) {
    const dir = path.join(gamesDir, id);
    const file = path.join(dir, "library.json");
    const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || "").split(","))
        .map(t => String(t).trim()).filter(t => t);
    const out = Object.assign({}, old, {
        name: String(body.name || "").trim() || id,
        author: String(body.author || "").trim(),
        version: String(body.version || "").trim(),
        tags,
        description: String(body.description || "").trim(),
    });
    delete out.genre;
    fs.writeFileSync(file, JSON.stringify(out, null, 4) + "\n");
    const built = path.join(dir, "built", "3ds", id + ".3dsx");
    if (fs.existsSync(built)) installGame(dir, built);
}

// Is everything needed for building there? The bundled toolchain folder (in
// the download), or devkitPro with its 3DS tools.
function setupStatus() {
    if (fs.existsSync(path.join(root, "toolchain", "runtime", "runtime.json")))
        return { bundled: true, devkitPro: false, libctru: true, ready: true };
    const dkp = [process.env.DEVKITPRO, "C:/devkitPro", "/opt/devkitpro"].filter(p => p)
        .find(p => fs.existsSync(path.join(p, "devkitARM", "bin", "arm-none-eabi-gcc.exe")) ||
            fs.existsSync(path.join(p, "devkitARM", "bin", "arm-none-eabi-gcc")));
    const has = rel => dkp && (fs.existsSync(path.join(dkp, rel)) || fs.existsSync(path.join(dkp, rel + ".exe")));
    return {
        devkitPro: !!dkp,
        libctru: !!has("libctru/lib/libctru.a"),
        ready: !!(dkp && has("libctru/lib/libctru.a")), // (3dsxtool is no longer needed)
    };
}

function validGame(id) {
    return typeof id === "string" && /^[\w.-]+$/.test(id) && gameFolders().includes(id);
}

// ---- jobs: long tasks (building, setting pictures) that the page watches ----------------

const jobs = new Map();
let nextJob = 1;

function startJob(title, script, args) {
    const id = String(nextJob++);
    const job = { id, title, log: "", done: false, ok: false };
    jobs.set(id, job);
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], { cwd: root, windowsHide: true });
    const add = d => { job.log += d.toString(); if (job.log.length > 200000) job.log = job.log.slice(-150000); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.on("close", code => { job.done = true; job.ok = code === 0; });
    child.on("error", e => { add("\n" + e.message); job.done = true; });
    return job;
}

// ---- what the 3DS downloads -------------------------------------------------------------

// A fingerprint of each file's contents, remembered while the file is unchanged.
const hashCache = new Map();
function fingerprint(file, st) {
    const key = file + ":" + st.size + ":" + st.mtimeMs;
    if (hashCache.has(key)) return hashCache.get(key);
    const data = fs.readFileSync(file);
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193);
    const hash = (h >>> 0).toString(16).padStart(8, "0") + st.size.toString(16);
    hashCache.set(key, hash);
    return hash;
}

function manifest() {
    const files = [];
    (function walk(dir, rel) {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir).sort()) {
            const full = path.join(dir, name), r = rel ? rel + "/" + name : name;
            const st = fs.statSync(full);
            if (st.isDirectory()) walk(full, r);
            else if (!/\.(part|tmp)$/.test(name)) files.push({ path: r, full, size: st.size, hash: fingerprint(full, st) });
        }
    })(libraryOut, "");
    return files;
}

let lastManifest = [];

// ---- helpers ----------------------------------------------------------------------

function isLocal(req) {
    const a = req.socket.remoteAddress || "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", c => {
            size += c.length;
            if (size > limit) { reject(new Error("too big")); req.destroy(); return; }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function send(res, code, type, body) {
    res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
    res.end(body);
}
const json = (res, obj, code = 200) => send(res, code, "application/json", JSON.stringify(obj));

function myAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces()))
        for (const a of list || [])
            if (a.family === "IPv4" && !a.internal) out.push(a);
    return out;
}

// ---- the server --------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://x");
        const p = url.pathname;

        // The 3DS library (any device on the home network).
        if (p === "/sync/manifest") {
            lastManifest = manifest();
            console.log(`3DS ${req.socket.remoteAddress} asked for the game list (${lastManifest.length} files).`);
            return send(res, 200, "text/plain", lastManifest.map(f => `${f.size}\t${f.hash}\t${f.path}`).join("\n") + "\n");
        }
        let m = /^\/sync\/file\/(\d+)$/.exec(p);
        if (m) {
            const f = lastManifest[Number(m[1])];
            if (!f || !fs.existsSync(f.full)) return send(res, 404, "text/plain", "not found");
            console.log(`  sending ${f.path}`);
            res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": fs.statSync(f.full).size });
            return fs.createReadStream(f.full).pipe(res);
        }

        // Everything else: only from this PC.
        if (!isLocal(req)) return send(res, 403, "text/plain", "Only available on the PC running the app.");

        if (p === "/" || p === "/index.html")
            return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(__dirname, "app", "index.html")));
        if (p === "/api/status") {
            lastPing = Date.now();
            return json(res, { addresses: myAddresses().map(a => a.address), port: PORT, setup: setupStatus() });
        }
        if (p === "/api/open-installer-page" && req.method === "POST") {
            // Opens devkitPro's official installer download page in the normal web browser.
            spawn("cmd", ["/c", "start", "", "https://github.com/devkitPro/installer/releases/latest"],
                { detached: true, stdio: "ignore", windowsHide: true }).unref();
            return json(res, { ok: true });
        }
        if (p === "/api/games")
            return json(res, gameFolders().map(gameInfo));
        if (p === "/api/add" && req.method === "POST") {
            const { link } = JSON.parse((await readBody(req, 10000)).toString() || "{}");
            if (!link || !/^https?:\/\//.test(link)) return json(res, { error: "Paste a MakeCode share link or GitHub URL." }, 400);
            return json(res, startJob("Adding " + link, "make-3ds.js", [link]));
        }
        m = /^\/api\/jobs\/(\d+)$/.exec(p);
        if (m) {
            const job = jobs.get(m[1]);
            return job ? json(res, job) : json(res, { error: "no such job" }, 404);
        }
        m = /^\/api\/games\/([\w.-]+)\/(info|art|rebuild)$/.exec(p);
        if (m) {
            const [, id, what] = m;
            if (!validGame(id)) return json(res, { error: "no such game" }, 404);
            if (what === "art" && req.method === "GET") {
                const own = path.join(gamesDir, id, "art.png"), dropped = path.join(root, "game art", id + ".png");
                const file = fs.existsSync(own) ? own : dropped;
                if (!fs.existsSync(file)) return send(res, 404, "text/plain", "no art");
                res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
                return fs.createReadStream(file).pipe(res);
            }
            if (req.method !== "POST") return json(res, { error: "use POST" }, 405);
            if (what === "info") {
                saveInfo(id, JSON.parse((await readBody(req, 100000)).toString()));
                return json(res, gameInfo(id));
            }
            if (what === "art") {
                const png = await readBody(req, 10 * 1024 * 1024);
                const tmp = path.join(os.tmpdir(), `mca3ds-art-${Date.now()}.png`);
                fs.writeFileSync(tmp, png);
                const job = startJob("New picture for " + id, "add-art.js", [path.join(gamesDir, id), tmp]);
                const timer = setInterval(() => { if (job.done) { clearInterval(timer); fs.rmSync(tmp, { force: true }); } }, 1000);
                return json(res, job);
            }
            if (what === "rebuild")
                return json(res, startJob("Rebuilding " + id, "make-3ds.js", [path.join(gamesDir, id)]));
        }
        send(res, 404, "text/plain", "not found");
    } catch (e) {
        json(res, { error: e.message }, 500);
    }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`MakeCode 3DS app running: http://localhost:${PORT}`);
    console.log("On the 3DS, choose Get games from PC in the library to get games from this PC.");
    console.log("Leave this window open while you use the app. Close it to stop.\n");
    if (WINDOW_MODE) openWindow(true);
    else if (process.platform === "win32" && !process.argv.includes("--no-browser"))
        spawn("cmd", ["/c", "start", "", `http://localhost:${PORT}`], { detached: true, stdio: "ignore" }).unref();
});
server.on("error", e => {
    if (e.code === "EADDRINUSE") {
        // Already running: just show it.
        console.log(`The app is already running: http://localhost:${PORT}`);
        if (WINDOW_MODE) openWindow(false);
        else process.exit(1);
        return;
    }
    console.log("Could not start: " + e.message);
    process.exit(1);
});

// ---- the app's own window ------------------------------------------------------------
// Microsoft Edge (part of Windows 10 and 11) in "app" mode: a plain window with
// no address bar or tabs. With its own profile folder, the Edge process lasts
// exactly as long as the window, so the app quits when the window is closed.

let lastPing = Date.now();

function busy() {
    for (const j of jobs.values()) if (!j.done) return true;
    return false;
}

function openWindow(owner) {
    const url = `http://localhost:${PORT}`;
    const edge = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]
        .filter(p => p).map(p => path.join(p, "Microsoft", "Edge", "Application", "msedge.exe")).find(p => fs.existsSync(p));
    if (!edge) {
        // No Edge: use the normal web browser, and quit once the page has
        // been closed for a while (it checks in every few seconds).
        spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
        if (owner) setInterval(() => { if (Date.now() - lastPing > 30000 && !busy()) process.exit(0); }, 5000);
        else process.exit(0);
        return;
    }
    const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "MakeCode3DS", "window");
    const win = spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, "--window-size=1100,800",
        "--no-first-run", "--no-default-browser-check"], { stdio: "ignore", detached: !owner });
    if (!owner) {
        win.unref();
        setTimeout(() => process.exit(0), 500);
        return;
    }
    // When Edge exits, quit once the page has also stopped checking in (it asks
    // for /api/status every 3 seconds). Edge can exit straight away while the
    // window lives on, if an Edge using this profile was already running and
    // took the window over, so the process alone is not enough to go by.
    // (The long wait allows for Edge slowing timers in minimised windows.)
    win.on("exit", () => {
        console.log("Edge process ended; the app stops once the window is closed.");
        setInterval(() => {
            if (Date.now() - lastPing > 90000 && !busy()) {
                console.log("Window closed.");
                process.exit(0);
            }
        }, 2000);
    });
}

// ---- announcing to the 3DS ----------------------------------------------------------

const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
udp.bind(() => {
    udp.setBroadcast(true);
    const msg = Buffer.from(`MCA3DS ${PORT}`);
    setInterval(() => {
        // To the whole-network address and to each home network's own broadcast
        // address (Windows does not always send the first one everywhere).
        const targets = new Set(["255.255.255.255"]);
        for (const a of myAddresses()) {
            const ip = a.address.split(".").map(Number), mask = a.netmask.split(".").map(Number);
            targets.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join("."));
        }
        for (const t of targets) udp.send(msg, ANNOUNCE_PORT, t, () => {});
    }, 1000);
});
