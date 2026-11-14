# Makecode Arcade on 3ds

> **Disclaimer:** this is an **unofficial fan project**. It is **not** made by,
> affiliated with, or endorsed by Microsoft or Microsoft MakeCode. MakeCode and
> Microsoft are trademarks of Microsoft Corporation. Games belong to the people
> who made them.

Play your [MakeCode Arcade](https://arcade.makecode.com) games on a Nintendo 3DS.

Paste a MakeCode Arcade share link into the app on your PC, and the game is turned
into a real 3DS program: not a browser emulator, but the game compiled to run
natively on the 3DS, so it runs fast. Your games appear in a library on the 3DS
HOME menu, and new games arrive over Wi-Fi.

## Features

- **Any MakeCode Arcade game** from a share link (or a GitHub project), including
  games with extensions, big games, and games with bigger screen sizes.
- **Native speed:** games are compiled for the 3DS's processor, and slow parts of
  MakeCode's libraries are tuned for it.
- **A game library on the HOME menu:** art, details, favourites, most played,
  recently added, and folders for every tag and every author.
- **Get games over Wi-Fi:** no taking the SD card out after the first setup.
- **Saves,** sound, the touch screen as a mouse, and an in-game menu (SELECT) to
  resume, restart or go back to the library.
- **Button mapping** for each game, including games that use the keyboard.
- **Nothing to install on the PC:** unzip and run.

## What you need

- A **Windows 10 or 11** PC.
- A **3DS, 2DS, New 3DS or New 2DS** with custom firmware (**Luma3DS**) and the
  Homebrew Launcher. Installing a HOME-menu app also needs **FBI**.
  A New 3DS or New 2DS runs games much faster than the original models.
- For sound: `sdmc:/3ds/dspfirm.cdc` on the SD card (made with the DSP1 homebrew).
  Without it, games run silent.

## Getting started

1. **Download** `MakeCode 3DS.zip` from the [Releases](../../releases) page and unzip
   it somewhere you can write to, such as Documents or the Desktop (not Program
   Files). Your games are kept in that folder too.
2. **Run `MakeCode 3DS.exe`.** Windows may warn that it is from an unknown
   publisher: choose *More info*, then *Run anyway*. If Windows asks whether the
   app may use the network, allow it on **private networks** so your 3DS can find it.
3. **Add a game:** paste a MakeCode Arcade share link and click **Add game**. The
   first build downloads MakeCode's own files, so it takes a little longer.
4. **First time on the 3DS:**
   - Copy the `built 3ds games/makecode-arcade` folder into the `3ds` folder on the
     SD card.
   - Install `built 3ds games/Makecode Arcade on 3ds.cia` with FBI to get the app on
     the HOME menu. (Or start `3ds/makecode-arcade/library.3dsx` from the Homebrew
     Launcher.)
5. **After that:** keep the app open on the PC, and on the 3DS choose
   **Get games from PC** in the library. Only new and changed files are downloaded.
   The PC and the 3DS must be on the same Wi-Fi network.

## Using the app on the PC

For each game you can edit its **name, author(s), version, tags and description**
(shown in the 3DS library), give it a **picture**, or **rebuild** it.

- **Several authors or tags:** separate them with commas. Every author and every
  tag gets its own folder on the 3DS; a game made by several people appears in each
  of their folders.
- **Pictures:** PNG files. Square pixel art works best. Pixel art that was saved
  enlarged is shrunk back to its real size, and the 3DS enlarges it by whole
  numbers, so it stays sharp.

## On the 3DS

**Library:**

- **Choosing:** Up/Down or tap to choose; A, or tap a game again, to play.
- **Going back:** B, or tap the "<" at the top left.
- **Favourites:** Y marks or unmarks a favourite.
- **Closing:** START.

**In a game:** SELECT opens a menu with *Resume*, *Restart game* and
*Back to library*. The game freezes while it is open. (To close a game, use the
HOME button.)

| 3DS button | Does (by default) |
|---|---|
| D-pad / Circle Pad | Arcade directions (and the arrow keys) |
| A | Arcade A (and Space) |
| B | Arcade B (and Enter) |
| START | MakeCode's menu |
| SELECT | the in-game menu |
| Touch screen | the mouse |

### Changing a game's buttons

For games that read the keyboard (the *browser-events* extension), a
`controls.json` with suggested bindings is made in the game's folder the first time
it is built. Edit it and rebuild the game. Each 3DS button lists up to four things
it presses:

```json
{ "buttons": { "A": ["arcade:A", "z"], "X": ["c"], "R": ["x"], "START": ["e"], "L": [] } }
```

- **3DS buttons:** `UP DOWN LEFT RIGHT A B X Y L R ZL ZR START`
- **Arcade inputs:** `arcade:A arcade:B arcade:up arcade:down arcade:left arcade:right arcade:menu`
- **Keyboard keys:** letters, digits, `Space`, `Enter`, `Shift`, `ArrowUp`, `ArrowDown`,
  `ArrowLeft`, `ArrowRight`, and so on.
- A button left out keeps its default; `[]` makes it do nothing.

## If something goes wrong

- **A game stops with "error N":** that is a MakeCode error code. The log is in
  `sdmc:/3ds/makecode-player/log.txt`.
- **"Get games from PC" cannot find the PC:** check the app is open, both are on
  the same Wi-Fi, and Windows Firewall allows the app on private networks.
- **A game will not build:** the build log in the app shows why. Some extensions
  use hardware features the 3DS does not have.
- **A game runs slowly:** big games can be heavy. A New 3DS or New 2DS helps a lot.

## For developers

How it works, how to build it from source, and how to test and speed up games:
see [DEVELOPING.md](DEVELOPING.md).

## Credits and licences

This project includes and builds on other people's work, credited with their
licences in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md): Microsoft MakeCode's
runtime and command-line tools (MIT), devkitPro's libctru, devkitARM and start-up
files, and Node.js.

This project's own code is under the MIT licence: see [LICENSE](LICENSE). Parts
made by others keep their own licences.
