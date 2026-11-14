#!/usr/bin/env node
// resolve-deps.js
// Downloads every GitHub dependency of a MakeCode project (recursively) and
// writes a "links" block into mkc.json so `mkc build` can use the local copies.
//
// Usage:  node resolve-deps.js <projectDir> [depsDir]
// Needs:  internet access. (No git required - it downloads from GitHub directly.)

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Handles "github:owner/repo#ref" and "github:owner/repo/subfolder#ref"
function parseGithub(spec) {
    if (typeof spec !== "string") return null;
    const m = /^github:([^/#]+)\/([^/#]+)(?:\/([^#]+))?(?:#(.+))?$/.exec(spec);
    if (!m) return null;
    return { owner: m[1], repo: m[2], sub: m[3] || "", ref: m[4] || "" };
}

// Unpacks a .tar.gz buffer into destDir, dropping the top-level folder that
// GitHub wraps every archive in.
function untar(gz, destDir) {
    const buf = zlib.gunzipSync(gz);
    const root = path.resolve(destDir);
    let longName = "";
    for (let off = 0; off + 512 <= buf.length;) {
        const h = buf.subarray(off, off + 512);
        if (h.every(b => b === 0)) break;
        const str = (a, n) => h.toString("utf8", a, a + n).replace(/\0.*$/s, "");
        const size = parseInt(str(124, 12).trim() || "0", 8);
        const type = str(156, 1) || "0";
        const data = buf.subarray(off + 512, off + 512 + size);
        off += 512 + Math.ceil(size / 512) * 512;

        if (type === "L") { longName = data.toString("utf8").replace(/\0.*$/s, ""); continue; }
        if (type === "x") {
            const m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
            if (m) longName = m[1];
            continue;
        }
        if (type === "g") continue;

        const prefix = str(345, 155);
        const name = longName || (prefix ? prefix + "/" : "") + str(0, 100);
        longName = "";
        const rel = name.split("/").slice(1).join("/");
        if (!rel) continue;
        const out = path.resolve(root, rel);
        if (out !== root && !out.startsWith(root + path.sep)) continue; // never write outside destDir
        if (type === "5") fs.mkdirSync(out, { recursive: true });
        else if (type === "0") {
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, data);
        }
    }
}

// Downloads owner/repo at ref (tag, branch or commit; "" = default branch) into dir.
async function downloadRepo(owner, repo, ref, dir) {
    const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref ? encodeURIComponent(ref) : "HEAD"}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${owner}/${repo}${ref ? "#" + ref : ""} (HTTP ${res.status})`);
    const tmp = dir + ".partial";
    fs.rmSync(tmp, { recursive: true, force: true });
    untar(Buffer.from(await res.arrayBuffer()), tmp);
    fs.renameSync(tmp, dir);
}

// Returns { name: folder } for every GitHub dependency and updates mkc.json.
async function resolveDeps(projectDir, depsDir) {
    projectDir = path.resolve(projectDir);
    depsDir = path.resolve(depsDir || path.join(projectDir, "..", "_deps"));
    const links = {};

    async function fetchRepo(g) {
        const tag = (g.ref || "HEAD").replace(/[^\w.-]/g, "_");
        const dir = path.join(depsDir, `${g.owner}__${g.repo}__${tag}`);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(depsDir, { recursive: true });
            console.log(`Downloading ${g.owner}/${g.repo} ${g.ref || "(default branch)"} ...`);
            await downloadRepo(g.owner, g.repo, g.ref, dir);
        }
        return g.sub ? path.join(dir, g.sub) : dir;
    }

    async function walk(pkgDir) {
        const pxtPath = path.join(pkgDir, "pxt.json");
        if (!fs.existsSync(pxtPath)) {
            console.warn(`Warning: no pxt.json in ${pkgDir}`);
            return;
        }
        const pxt = readJson(pxtPath);
        for (const [name, spec] of Object.entries(pxt.dependencies || {})) {
            const g = parseGithub(spec);
            if (!g) continue; // built-in ("*"), shared script ("pub:"), or local: mkc handles these
            if (links[name]) {
                console.warn(`Note: "${name}" is required more than once; keeping the first version.`);
                continue;
            }
            const dir = await fetchRepo(g);
            links[name] = dir;
            await walk(dir); // the dependency may have GitHub dependencies of its own
        }
    }

    await walk(projectDir);

    const mkcPath = path.join(projectDir, "mkc.json");
    const mkc = fs.existsSync(mkcPath) ? readJson(mkcPath) : {};
    // mkc needs the trailing slash, or it builds broken download URLs.
    mkc.targetWebsite = (mkc.targetWebsite || "https://arcade.makecode.com").replace(/\/*$/, "/");
    mkc.links = mkc.links || {};
    for (const [name, dir] of Object.entries(links)) {
        mkc.links[name] = path.relative(projectDir, dir).split(path.sep).join("/");
    }
    fs.writeFileSync(mkcPath, JSON.stringify(mkc, null, 4) + "\n");
    console.log(`${Object.keys(links).length} GitHub extensions linked in ${mkcPath}`);
    return links;
}

module.exports = { resolveDeps, downloadRepo };

if (require.main === module) {
    resolveDeps(process.argv[2] || ".", process.argv[3]).catch(e => {
        console.error("ERROR: " + e.message);
        process.exit(1);
    });
}
