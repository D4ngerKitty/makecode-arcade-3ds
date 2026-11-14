// Profiler for the PC test harness (included by platqemu.cpp).
//
// QEMU is run with "-icount", which makes the emulated machine's clock tick
// once per executed instruction (1 instruction = 1 ns). Its timers then
// measure work done rather than wall-clock time:
//  - timer 1 runs freely, to count instructions per frame;
//  - timer 0 interrupts every ~100,000 instructions and the handler records
//    where the program was. tools/test-qemu.js turns that into a table of
//    which functions the time went to.

#define TIMER0 ((volatile uint32_t *)0x101e2000) // [0] load, [1] value, [2] control, [3] clear
#define TIMER1 ((volatile uint32_t *)0x101e2020)
#define VIC_INT_ENABLE (*(volatile uint32_t *)0x10140010)

#define PROF_MAX_SAMPLES 400000
static uint32_t *profSamples;
static volatile int profCount;
static volatile int profiling;
static int profStartFrame = -1;

extern "C" void pxt_qemu_irq(); // in boot.s; calls prof_sample

extern "C" void prof_sample(uint32_t pc) {
    TIMER0[3] = 1; // acknowledge the interrupt
    if (profiling && profCount < PROF_MAX_SAMPLES)
        profSamples[profCount++] = pc;
}

// Thousands of instructions executed since start-up (wraps after ~70 minutes).
static uint32_t profKiloInstructions() {
    return ~TIMER1[1];
}

static void profInit() {
    TIMER1[0] = 0xffffffff;
    TIMER1[2] = 0x82; // enabled, 32-bit, free-running
    // IRQ vector: "ldr pc, [pc, #0x18]" at 0x18 loads the address stored at 0x38.
    *(volatile uint32_t *)0x38 = (uint32_t)pxt_qemu_irq;
    *(volatile uint32_t *)0x18 = 0xe59ff018;
}

static void profStart() {
    profSamples = (uint32_t *)malloc(PROF_MAX_SAMPLES * sizeof(uint32_t));
    profCount = 0;
    profiling = 1;
    TIMER0[0] = 97;   // microseconds = thousands of instructions between samples
    TIMER0[2] = 0xe2; // enabled, periodic, interrupt on, 32-bit
    VIC_INT_ENABLE = 1 << 4;
    asm volatile("cpsie i");
}

static void profSave() {
    if (!profiling)
        return;
    profiling = 0;
    int f = hostOpenForWrite("profile.bin");
    if (f < 0)
        return;
    hostWrite(f, profSamples, profCount * sizeof(uint32_t));
    hostClose(f);
}
