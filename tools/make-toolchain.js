#!/usr/bin/env node
// make-toolchain.js
// Makes toolchain/: everything needed to build 3DS games WITHOUT devkitPro,
// taken from an installed devkitPro. It is put in the downloadable version
// (tools/make-release.js); on a PC with devkitPro it is not needed.
//
//   toolchain/bin/       as.exe, ld.exe            (GNU binutils, GPL v3)
//   toolchain/lib/       start-up files, libraries:
//                          3dsx_crt0.o, 3dsx.ld    (devkitPro, MPL 2.0)
//                          crt*.o, libgcc.a, libstdc++.a (GCC, GPL v3 with
//                                                   the runtime exception)
//                          libc.a, libg.a, libm.a, libsysbase.a (newlib)
//                          libctru.a               (libctru, zlib)
//   toolchain/runtime/   the 3DS runtime, ready-built, + runtime.json
//   toolchain/src/       source of the MPL files, and where to get the rest
//   toolchain/LICENSES/  the licences
//
// Usage:  node tools/make-toolchain.js   (needs devkitPro installed)

const fs = require("fs");
const path = require("path");
const pb = require("./player-build.js");

if (!pb.dkp) pb.fail("devkitPro is needed to make the toolchain folder.");
const dkp = pb.dkp;
const out = pb.toolchainDir;
const arm = path.join(dkp, "devkitARM");
const gccVersion = fs.readdirSync(path.join(arm, "lib", "gcc", "arm-none-eabi"))[0];
const gccLib = path.join(arm, "lib", "gcc", "arm-none-eabi", gccVersion, "armv6k", "fpu");
const newlib = path.join(arm, "arm-none-eabi", "lib", "armv6k", "fpu");
const exe = process.platform === "win32" ? ".exe" : "";

fs.rmSync(out, { recursive: true, force: true });
for (const d of ["bin", "lib", "runtime", "src", "LICENSES"]) fs.mkdirSync(path.join(out, d), { recursive: true });
const copy = (from, to) => {
    if (!fs.existsSync(from)) pb.fail(`${from} is missing from devkitPro`);
    fs.copyFileSync(from, to);
};

// ---- programs and libraries -------------------------------------------------------
copy(path.join(arm, "bin", "arm-none-eabi-as" + exe), path.join(out, "bin", "as" + exe));
copy(path.join(arm, "bin", "arm-none-eabi-ld" + exe), path.join(out, "bin", "ld" + exe));
for (const f of ["crti.o", "crtbegin.o", "crtend.o", "crtn.o", "libgcc.a"]) copy(path.join(gccLib, f), path.join(out, "lib", f));
for (const f of ["3dsx_crt0.o", "libc.a", "libg.a", "libm.a", "libsysbase.a", "libstdc++.a"]) copy(path.join(newlib, f), path.join(out, "lib", f));
copy(path.join(arm, "arm-none-eabi", "lib", "3dsx.ld"), path.join(out, "lib", "3dsx.ld"));
copy(path.join(dkp, "libctru", "lib", "libctru.a"), path.join(out, "lib", "libctru.a"));

// ---- the runtime, ready-built ---------------------------------------------------------
console.log("Compiling the 3DS runtime...");
const objects = pb.compileRuntime("3ds");
const names = objects.map(o => path.basename(o));
if (new Set(names).size !== names.length) pb.fail("two runtime files have the same name");
objects.forEach(o => copy(o, path.join(out, "runtime", path.basename(o))));
const symbols = pb.runtimeSymbols(objects);
fs.writeFileSync(path.join(out, "runtime", "runtime.json"), JSON.stringify({
    note: "Made by tools/make-toolchain.js from player/ - the 3DS runtime, compiled. objects: link order; defined: symbols; byName: C++ name -> symbol.",
    objects: names, defined: symbols.defined, byName: symbols.byName,
}));

// ---- licences and sources -------------------------------------------------------------
const lic = path.join(__dirname, "toolchain-licenses");
for (const f of fs.readdirSync(lic)) copy(path.join(lic, f), path.join(out, "LICENSES", f));
const versionOf = p => (pb.run(p, ["--version"]).split(/\r?\n/)[0] || "").trim();
fs.writeFileSync(path.join(out, "src", "SOURCES.txt"), [
    "Where the parts of this folder come from, and their source code.",
    "",
    `Taken from devkitPro (https://devkitpro.org) devkitARM with GCC ${gccVersion}:`,
    `- bin/as.exe, bin/ld.exe: ${versionOf(path.join(out, "bin", "as" + exe))}; ${versionOf(path.join(out, "bin", "ld" + exe))}.`,
    "  GPL v3 (LICENSES/GPL-3.0.txt). Source: https://github.com/devkitPro/binutils-gdb",
    "  (devkitPro's changes) on top of https://sourceware.org/binutils/",
    "- lib/crt*.o, lib/libgcc.a, lib/libstdc++.a: GCC's support libraries. GPL v3 with the",
    "  GCC Runtime Library Exception (LICENSES/GCC-runtime-library-exception-3.1.txt), which",
    "  lets programs built with them use any licence. Source: https://github.com/devkitPro/gcc",
    "  on top of https://gcc.gnu.org/",
    "- lib/libc.a, lib/libg.a, lib/libm.a, lib/libsysbase.a: newlib, mostly permissive licences",
    "  (LICENSES/newlib-COPYING.NEWLIB.txt). Source: https://github.com/devkitPro/newlib",
    "- lib/3dsx_crt0.o, lib/3dsx.ld: devkitPro's start-up code and memory layout for 3DS",
    "  programs. Mozilla Public License 2.0 (LICENSES/MPL-2.0.txt). Source: src/ in this folder,",
    "  and https://github.com/devkitPro/devkitarm-crtls",
    "- lib/libctru.a: libctru, zlib licence (LICENSES/libctru-zlib.txt).",
    "  Source: https://github.com/devkitPro/libctru",
    "",
    "- runtime/: this project's 3DS runtime (player/ in the project), compiled.",
    "  Includes Microsoft MakeCode's C++ runtime (MIT licence).",
    "",
    "This folder is not made or endorsed by devkitPro.",
    "",
].join("\r\n"));
// Source of the MPL-licensed files, as the MPL asks.
(async () => {
    for (const f of ["3dsx_crt0.s", "3dsx.ld"]) {
        const r = await fetch("https://raw.githubusercontent.com/devkitPro/devkitarm-crtls/master/" + f);
        if (!r.ok) pb.fail(`could not download the source of ${f} (${r.status})`);
        fs.writeFileSync(path.join(out, "src", f), await r.text());
    }
    let size = 0;
    (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else size += s.size; } })(out);
    console.log(`\nDone: ${out} (${(size / 1024 / 1024).toFixed(0)} MB, ${names.length} runtime files)`);
})();
