#ifndef __PXTCORE_H
#define __PXTCORE_H

#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>

namespace pxt {
void *gcAllocBlock(size_t sz);
}

extern "C" void dmesg(const char *fmt, ...);
extern "C" void vdmesg(const char *format, va_list arg);
#define DMESG ::dmesg

static inline void itoa(int v, char *dst) {
    snprintf(dst, 30, "%d", v);
}

extern "C" void *xmalloc(size_t sz);
#define xfree free

#define GC_ALLOC_BLOCK gcAllocBlock
// The game heap grows one block at a time, and only after a garbage
// collection finds it nearly full. Small blocks mean many collections while a
// big game starts up, so use large ones: the 3DS has memory to spare.
#define GC_BLOCK_SIZE (1024 * 256)

#define PXT_HARD_FLOAT 1

#endif
