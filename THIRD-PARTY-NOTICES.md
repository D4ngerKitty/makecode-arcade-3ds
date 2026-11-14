# Third-party notices

Makecode Arcade on 3ds is an unofficial fan project, not affiliated with or
endorsed by Microsoft, Microsoft MakeCode, or devkitPro. It uses the following
work by others.

## In this repository

- **Microsoft MakeCode's C++ runtime** (from pxt-common-packages and pxt-arcade),
  copied into `player/pxt/` by `tools/extract-runtime.js` and patched for the 3DS.
  MIT licence, Copyright (c) Microsoft Corporation.
  https://github.com/microsoft/pxt-common-packages, https://github.com/microsoft/pxt-arcade
- **MakeCode libraries** (game, screen), copied and speed-tuned by
  `tools/patch-libs.js` at build time. MIT licence, Copyright (c) Microsoft Corporation.
- **`library/font8x8.bin`:** the 8x8 console font from libctru. zlib licence,
  Copyright (C) libctru contributors. https://github.com/devkitPro/libctru
- **`library/app.rsf`:** based on the 3DS homebrew template from
  https://github.com/Steveice10/buildtools
- **Licence texts** for the bundled toolchain, in `tools/toolchain-licenses/`.

## In the download (MakeCode 3DS.zip)

- **Node.js** (`MakeCode 3DS.exe` is built from it). MIT licence. https://nodejs.org
- **MakeCode command-line tools** (`mkc/makecode`). MIT licence, Copyright (c)
  Microsoft Corporation. https://github.com/microsoft/pxt-mkc
- **`toolchain/`**, from devkitPro's devkitARM and libctru (https://devkitpro.org).
  It is not made or endorsed by devkitPro:
  - `as`, `ld`: GNU binutils, GPL v3.
  - `crt*.o`, `libgcc.a`, `libstdc++.a`: GCC's support libraries, GPL v3 with the
    GCC Runtime Library Exception.
  - `libc.a`, `libg.a`, `libm.a`, `libsysbase.a`: newlib, mostly permissive licences.
  - `3dsx_crt0.o`, `3dsx.ld`: devkitPro's 3DS start-up code and memory layout,
    Mozilla Public License 2.0 (source included).
  - `libctru.a`: zlib licence.

  Licence texts are in `toolchain/LICENSES/`, and where to get each part's source
  code is in `toolchain/src/SOURCES.txt`.

## In every built game

Games built with this project contain libctru (zlib licence), newlib, and GCC's
support libraries (covered by the GCC Runtime Library Exception, so they place no
licence requirements on the games), plus MakeCode's runtime (MIT).

Each game belongs to its own creator. This project only converts games that users
choose to add.
