# Developing Makecode Arcade on 3ds

> Unofficial fan project, not affiliated with or endorsed by Microsoft or
> Microsoft MakeCode. See the [README](README.md).

## How it works

1. **MakeCode compiles the game.** The game is downloaded with MakeCode's
   command-line tools (`mkc`) and compiled for MakeCode's Raspberry Pi target,
   which produces ARM machine code as assembly (`built/rpi/binary.asm`).
2. **That assembly is translated** into standard GNU assembler syntax
   (`tools/asm2gas.js`) and assembled into an object file.
3. **It is linked with a 3DS runtime** (`player/`): MakeCode's own C++ runtime,
   plus a 3DS layer for fibers, the screen, buttons, touch, sound and saves.
4. **The result is packed** as a `.3dsx` (`tools/3dsx.js`, `tools/smdh.js`) and put
   in the library folder for the SD card.

Speed comes from running real machine code, plus speed-tuned copies of some
MakeCode libraries and extensions (`tools/patch-libs.js`, with native helpers in
`player/source/accel.cpp`). Every tuning gives exactly the same results as the
stock code; the checks below compare screenshots and output files.

## Requirements

- **Node.js** (a recent version; the `.exe` is built from it).
- **MakeCode's command-line tools:** `npm install -g makecode`.
- **devkitPro** with the 3DS tools (devkitARM, libctru): needed to compile the
  runtime. Users of the download do not need it (see "The bundled toolchain").
- Optional: **QEMU** for running games on the PC
  (`winget install SoftwareFreedomConservancy.QEMU`).
- Optional, for the `.cia`: **makerom** (3DSGuy/Project_CTR) and **bannertool**
  in `tools/bin/` (not included).

## Building

```
node tools/app.js                      the PC app (or double-click "MakeCode 3DS.bat")
node tools/make-3ds.js <share link>    add a game from the command line
node tools/make-3ds.js <game>          rebuild a game (folder name in games/)
node tools/build-all.js                rebuild every game (--quick: only re-link)
node tools/build-library.js            build the 3DS library app, refresh its folder
node tools/make-app-art.js             icon, banner and sound from library/ art
node tools/build-cia.js                the HOME-menu .cia
node tools/make-release.js             the download: release/MakeCode 3DS.zip
```

`make-3ds.js` runs two steps, which can also be run on their own:
`tools/get-game.js` (download and compile with MakeCode, translate, assemble) and
`tools/build-3ds.js` (link with the runtime, pack as `.3dsx`).

## Project layout

| Folder | What is in it |
|---|---|
| `tools/` | All scripts; `tools/app/` is the PC app's page, `tools/launcher/` the `.exe`'s start-up code |
| `tools/3ds-compat/` | A small MakeCode extension added to every 3DS build, for functions games expect but the build target lacks |
| `player/source/` | The 3DS side of the runtime |
| `player/qemu/` | The PC test harness side |
| `player/pxt/` | MakeCode's C++ runtime, copied in by `tools/extract-runtime.js` (generated; patch it in that script, not there) |
| `library/` | The 3DS library app, its `.cia` starter (`forwarder/`), art, colours (`theme.cfg`) |
| `games/` | Your games, one MakeCode project per folder, plus `_deps/` (their GitHub extensions). Not in the repository |
| `built 3ds games/` | Finished `.3dsx` files, and `makecode-arcade/` laid out as on the SD card. Not in the repository |
| `toolchain/` | The bundled build tools for the download. Generated, not in the repository |

## The bundled toolchain

The download includes `toolchain/`: the assembler, linker and libraries a game
build needs, and the runtime ready-built, with their licences
(`toolchain/LICENSES`) and where to get their sources (`toolchain/src/SOURCES.txt`).
With it, no devkitPro install is needed. When devkitPro is installed it is used
instead, since it is needed to change the runtime.

```
node tools/make-toolchain.js     make toolchain/ from an installed devkitPro
node tools/check-toolchain.js    check: bundled builds = devkitPro builds, every game
node tools/check-3dsx.js         check: our .3dsx writer = devkitPro's 3dsxtool
```

`MCA3DS_TOOLCHAIN=bundled` (or `=devkitpro`) forces one or the other.

## Testing on the PC

```
node tools/test-qemu.js <game> --frames 900 --shots 300,600 --input "100:A:1,110:A:0"
```

This runs the same runtime and compiled game code under QEMU, prints the log, and
saves screenshots to `games/<game>/built/qemu/`. `--input` is a button script:
`frame:BUTTON:1` presses, `frame:BUTTON:0` releases.

- Each "frame N" log line shows how many instructions a frame took (lower is faster).
- `--profile <frame>` prints which functions the time went to from that frame on.
- If a game hangs, `node tools/qemu-where.js <game>` shows where.

## Speeding up a game

1. Profile it with `--profile` to find the expensive library functions.
2. Add a patch in `tools/patch-libs.js`. Built-in libraries go in `PATCHES`,
   GitHub extensions in `EXTENSION_PATCHES`, with native helpers in `accel.cpp` if
   needed. A patch must give exactly the same results as the original.
3. Compare screenshots with the same `--input` before and after, and check the
   instructions per frame went down. `node tools/get-game.js <game> --stock-libs`
   builds without any patches, for comparison.

## On the 3DS

- **Log:** `sdmc:/3ds/makecode-player/log.txt`
- **Saves:** `sdmc:/3ds/makecode-player/saves/<game>/save.bin`
- **Library:** `sdmc:/3ds/makecode-arcade/`. Inside it, `library.dat` holds play
  counts and favourites, and `sync.dat` records what Wi-Fi downloads already got.
- **Panic codes** ("error N") are MakeCode's; 800-899 are internal runtime checks.
