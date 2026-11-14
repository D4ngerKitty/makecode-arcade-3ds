// The startup program built into "MakeCode 3DS.exe" (see tools/make-release.js).
//
// The .exe is Node.js with this file built in. Everything else (the app and
// all the build tools) stays as ordinary files in the tools folder next to
// the .exe, so they can be fixed or updated without rebuilding the .exe.
//
//   MakeCode 3DS.exe                   opens the app in its own window
//   MakeCode 3DS.exe <script.js> args  runs that tool script (the tools start
//                                      each other this way)

const fs = require("fs");
const path = require("path");
const Module = require("module");

const exeDir = path.dirname(process.execPath);

// Trust Windows' own certificate store for downloads, as well as Node's
// built-in list. Needed on networks that inspect HTTPS traffic (common on
// school and work networks, and with some antivirus software); without it,
// downloading games and MakeCode's files fails with certificate errors.
try {
    const tls = require("tls");
    const certs = new Set([...tls.getCACertificates("bundled"), ...tls.getCACertificates("system")]);
    tls.setDefaultCACertificates([...certs]);
} catch (e) {
    // Older Node.js without these functions: keep the built-in list.
}
process.env.NODE_USE_SYSTEM_CA = "1";

// The first argument may repeat the .exe's own path (single-executable apps do that).
let args = process.argv.slice(1);
if (args[0] && path.resolve(args[0]).toLowerCase() === path.resolve(process.execPath).toLowerCase()) args = args.slice(1);

let script;
if (args[0] && fs.existsSync(args[0]) && fs.statSync(args[0]).isFile()) {
    script = path.resolve(args[0]);
    args = args.slice(1);
} else {
    script = path.join(exeDir, "tools", "app.js");
    process.env.MCA3DS_WINDOW = "1"; // tells the app to open its own window and log to a file
    if (!fs.existsSync(script)) {
        // Shown as a message box, since there is no console window.
        require("child_process").spawnSync("mshta", [`javascript:alert("MakeCode 3DS: the tools folder is missing next to MakeCode 3DS.exe. Unzip the whole download, not just the .exe.");close()`]);
        process.exit(1);
    }
}

process.argv = [process.execPath, script, ...args];
// Run it as the main program (so it behaves exactly like "node script.js").
Module._load(script, null, true);
