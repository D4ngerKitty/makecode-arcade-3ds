// Fibers, events and start-up for the MakeCode runtime.
//
// MakeCode programs are made of many small "fibers" (the main program, every
// forever loop, every event handler). Exactly one runs at a time and they
// only hand over control when they pause or wait, so they are implemented
// here as plain stack switches inside a single 3DS thread: no locks, no
// thread limit, and nothing ever runs "at the same time" as game code.

#include "pxt.h"
#include "plat.h"

#include <malloc.h>

extern "C" void pxt3ds_switch(void **saveSp, void *loadSp);
extern "C" void pxt3ds_fiber_boot();

// The compiled game (see tools/asm2gas.js).
extern "C" const uint8_t pxt_user_start[];

void *xmalloc(size_t sz) {
    auto r = malloc(sz);
    if (r == NULL)
        target_panic(PANIC_GC_OOM);
    return r;
}

void *operator new(size_t size) {
    return xmalloc(size);
}
void *operator new[](size_t size) {
    return xmalloc(size);
}
void operator delete(void *p) noexcept {
    free(p);
}
void operator delete[](void *p) noexcept {
    free(p);
}
void operator delete(void *p, size_t) noexcept {
    free(p);
}
void operator delete[](void *p, size_t) noexcept {
    free(p);
}

namespace pxt {

#define FIBER_STACK_SIZE (128 * 1024)
#define STACK_GUARD 0x5afe57ac

enum FiberState { F_READY, F_SLEEPING, F_WAITING, F_DEAD };

struct Fiber {
    Fiber *next;
    void *sp;        // saved stack pointer while not running
    uint32_t *stack; // lowest address of the stack block (NULL for the main fiber)
    int state;
    uint64_t wakeTime;
    int waitSource;
    int waitValue;
    void (*runner)(Fiber *);
    ThreadContext *ctx;
    // These two are GC roots and must stay next to each other.
    Action act;
    TValue arg0;
};

struct Event {
    Event *next;
    int source;
    int value;
};

static Fiber mainFiber;
static Fiber *allFibers = &mainFiber; // every fiber that has not finished
static Fiber *current = &mainFiber;
static Fiber *zombies;       // finished fibers whose stacks can be freed
static uint32_t *freeStacks; // stack blocks ready for reuse (linked through word 1)
static Event *eventHead, *eventTail;
uint64_t startTime; // not static: pxt_time_paused adjusts it

volatile bool paniced;
char **initialArgv;

// ---- time ------------------------------------------------------------------

uint64_t current_time_us() {
    return plat_time_us() - startTime;
}

int current_time_ms() {
    return current_time_us() / 1000;
}

void sleep_core_us(uint64_t us) {
    plat_sleep_us(us);
}

// Only one fiber ever runs, so there is nothing to lock.
void startUser() {}
void stopUser() {}
int tryLockUser() {
    return 0;
}

// ---- scheduling ------------------------------------------------------------

static void runAct(Fiber *f) {
    pxt::runAction1(f->act, f->arg0);
}

static void runFor(Fiber *f) {
    while (true) {
        pxt::runAction0(f->act);
        sleep_ms(20);
    }
}

static void fiberEntry(Fiber *f) {
    f->runner(f);
    releaseFiber();
}

static uint32_t *allocStack() {
    if (freeStacks) {
        auto s = freeStacks;
        freeStacks = (uint32_t *)s[1];
        return s;
    }
    return (uint32_t *)xmalloc(FIBER_STACK_SIZE);
}

// Frees fibers that have finished. Must not run on a stack it frees.
static void reapZombies() {
    while (zombies) {
        auto f = zombies;
        zombies = f->next;
        unregisterGC(&f->act, 2);
        f->stack[1] = (uint32_t)freeStacks;
        freeStacks = f->stack;
        delete f;
    }
}

static Fiber *setupFiber(Action a, TValue arg, void (*runner)(Fiber *)) {
    auto f = new Fiber();
    memset(f, 0, sizeof(Fiber));
    f->act = a;
    f->arg0 = arg;
    f->runner = runner;
    f->state = F_READY;
    registerGC(&f->act, 2);

    f->stack = allocStack();
    f->stack[0] = STACK_GUARD;

    // Build the frame pxt3ds_switch expects to find: d8-d15, then r3-r11, lr.
    auto top = (uint32_t *)((uint8_t *)f->stack + FIBER_STACK_SIZE);
    top -= 10;
    memset(top, 0, 10 * sizeof(uint32_t));
    top[1] = (uint32_t)(void (*)(Fiber *))fiberEntry; // r4
    top[2] = (uint32_t)f;                             // r5
    top[9] = (uint32_t)pxt3ds_fiber_boot;             // lr
    top -= 16;
    memset(top, 0, 16 * sizeof(uint32_t));
    f->sp = top;

    // Add at the end, so fibers start in the order they were created.
    auto p = allFibers;
    while (p->next)
        p = p->next;
    p->next = f;
    return f;
}

static void processEvents() {
    while (eventHead) {
        auto ev = eventHead;
        eventHead = ev->next;
        if (!eventHead)
            eventTail = NULL;

        for (auto f = allFibers; f; f = f->next) {
            if (f->state != F_WAITING)
                continue;
            if (f->waitValue != ev->value && f->waitValue != DEVICE_EVT_ANY)
                continue;
            if (f->waitSource == ev->source) {
                f->state = F_READY;
            } else if (f->waitSource == DEVICE_ID_NOTIFY && ev->source == DEVICE_ID_NOTIFY_ONE) {
                f->state = F_READY;
                break; // wake only one
            }
        }

        auto curr = findBinding(ev->source, ev->value);
        while (curr) {
            setupFiber(curr->action, fromInt(ev->value), runAct);
            curr = nextBinding(curr->next, ev->source, ev->value);
        }
        delete ev;
    }
}

// Waits until some fiber can run and returns it, starting the search just
// after `after` so that every fiber gets its turn.
static Fiber *pickNext(Fiber *after) {
    for (;;) {
        plat_poll();
        processEvents();

        auto now = plat_time_us();
        uint64_t nearest = now + 2000;
        for (auto f = allFibers; f; f = f->next) {
            if (f->state == F_SLEEPING) {
                if (f->wakeTime <= now)
                    f->state = F_READY;
                else if (f->wakeTime < nearest)
                    nearest = f->wakeTime;
            }
        }

        auto first = (after && after->next) ? after->next : allFibers;
        auto f = first;
        do {
            if (f->state == F_READY)
                return f;
            f = f->next ? f->next : allFibers;
        } while (f != first);

        plat_sleep_us(nearest - now);
    }
}

// Gives control to the next fiber that can run. Returns when this fiber is
// chosen again.
static void schedule() {
    if (current->stack && current->stack[0] != STACK_GUARD)
        target_panic(PANIC_STACK_OVERFLOW);

    auto next = pickNext(current);
    if (next != current) {
        auto prev = current;
        current = next;
        pxt3ds_switch(&prev->sp, next->sp);
    }
    // Whoever ran before us may have finished; we are on our own stack, so
    // it is safe to free theirs.
    reapZombies();
}

void releaseFiber() {
    auto self = current;
    self->state = F_DEAD;

    // Remember who came before us in the list, then unlink ourselves.
    Fiber *before = NULL;
    if (allFibers == self) {
        allFibers = self->next;
    } else {
        for (auto f = allFibers; f; f = f->next)
            if (f->next == self) {
                before = f;
                f->next = self->next;
                break;
            }
    }

    if (!allFibers) // nothing left that could ever run
        plat_exit();

    if (self->stack) {
        self->next = zombies;
        zombies = self;
    }

    // Still on our own stack here, which is fine: it is only freed by the
    // next fiber, after the switch.
    auto next = pickNext(before);
    current = next;
    void *discard;
    pxt3ds_switch(&discard, next->sp);
    for (;;) {
    }
}

void sleep_ms(unsigned ms) {
    current->state = ms ? F_SLEEPING : F_READY;
    current->wakeTime = plat_time_us() + (uint64_t)ms * 1000;
    schedule();
}

void sleep_us(uint64_t us) {
    if (us > 50000)
        sleep_ms(us / 1000);
    else
        plat_sleep_us(us);
}

void waitForEvent(int source, int value) {
    current->waitSource = source;
    current->waitValue = value;
    current->state = F_WAITING;
    schedule();
}

void runInParallel(Action a) {
    setupFiber(a, 0, runAct);
}

void runForever(Action a) {
    setupFiber(a, 0, runFor);
}

// ---- events ----------------------------------------------------------------

void raiseEvent(int id, int event) {
    auto e = new Event();
    e->next = NULL;
    e->source = id;
    e->value = event;
    if (eventTail)
        eventTail->next = e;
    else
        eventHead = e;
    eventTail = e;
}

int allocateNotifyEvent() {
    static int notifyId;
    return ++notifyId;
}

void registerWithDal(int id, int event, Action a, int flags) {
    setBinding(id, event, a);
}

// ---- per-fiber state for the garbage collector -----------------------------

ThreadContext *getThreadContext() {
    return current->ctx;
}

void setThreadContext(ThreadContext *ctx) {
    current->ctx = ctx;
}

void *threadAddressFor(ThreadContext *, void *sp) {
    return sp;
}

void *gcAllocBlock(size_t sz) {
    return xmalloc(sz);
}

// ---- start-up --------------------------------------------------------------

// Referenced by the stock start-up code, which startGame() replaces.
extern const uintptr_t functionsAndBytecode[] = {0};

unsigned afterProgramPage() {
    return 0;
}


} // namespace pxt

void pxt_time_paused(uint64_t us) {
    pxt::startTime += us;
}

namespace pxt {

void initRuntime() {
    startTime = plat_time_us();
    target_init();
}

void startGame() {
    bytecode = (uint16_t *)pxt_user_start;
    if (((uint32_t *)bytecode)[0] != 0x923B8E70)
        target_panic(PANIC_INVALID_BINARY_HEADER);

    mainFiber.state = F_READY;

    globals = (TValue *)app_alloc(sizeof(TValue) * getNumGlobals());
    memset(globals, 0, sizeof(TValue) * getNumGlobals());
    globals[0] = (TValue)&globals;

    initPerfCounters();
    initRuntime();
    DMESG("Starting: %s", programName()->getUTF8Data());
    DMESG("Code at %p, %d globals", bytecode, getNumGlobals());

    // The game's entry point follows its 64-byte header.
    runAction0((Action)((uintptr_t)bytecode + 64));

    DMESG("Main program finished; game loop running");
    // The main program has finished; event handlers and loops keep running.
    releaseFiber();
}

} // namespace pxt

extern "C" void target_panic(int error_code) {
    pxt::paniced = true;
    DMESG("PANIC %d", error_code);
    plat_panic(error_code);
    for (;;) {
    }
}
