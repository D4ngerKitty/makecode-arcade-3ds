// Platform description for the MakeCode runtime on the 3DS.
#ifndef __PXT_PLATFORM_H
#define __PXT_PLATFORM_H

// The games are compiled for MakeCode's Raspberry Pi (Linux) target, so the
// runtime must use the same data layouts as its Linux build. There, array
// lengths are 32-bit; elsewhere the runtime defaults to 16-bit, and the
// compiled game code then reads garbage as the length.
#define ramint_t uint32_t

#define OUTPUT_BITS 12
#define IMAGE_BITS 4

// The garbage collector keeps a list of every fiber's stack.
#define PXT_GC_THREAD_LIST 1
#define PXT_IN_ISR() false

// Objects built into the program (the game's own data and the runtime's
// constants) must never be modified or freed. On the 3DS the whole program
// image sits below 0x08000000 and all heap memory is at or above it.
#define PXT_IS_READONLY(v) (isTagged(v) || (uintptr_t)(v) < 0x08000000)

// Where game saves go; one folder per game inside it.
#ifdef __3DS__
#define SETTINGSDIR "sdmc:/3ds/makecode-player/saves"
#else
#define SETTINGSDIR "saves" // PC test harness
#endif

#endif
