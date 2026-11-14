@ PC test harness only: switches on the things the 3DS system software has
@ already switched on by the time a program starts.
    .arch armv6k
    .fpu vfp
    .arm
    .text

@ The very first code to run; continues into the normal C start-up code.
    .global pxt_qemu_boot
    .type pxt_qemu_boot, %function
pxt_qemu_boot:
    @ Allow use of the floating-point unit, then turn it on.
    mrc p15, 0, r0, c1, c0, 2
    orr r0, r0, #0x00f00000
    mcr p15, 0, r0, c1, c0, 2
    mov r0, #0x40000000
    vmsr fpexc, r0

    @ Turn on the memory mapper with a plain one-to-one map of all 4 GB
    @ (4096 one-megabyte sections, read/write, ordinary cached memory).
    @ Without it the emulator treats all memory as device memory, where
    @ reads and writes at unaligned addresses are errors; the 3DS allows them.
    ldr r0, =0x0f000000         @ the table lives near the top of RAM
    ldr r1, =0x00000c0e         @ section, read/write, cacheable + bufferable
    mov r2, #0
1:  orr r3, r1, r2, lsl #20
    str r3, [r0, r2, lsl #2]
    add r2, r2, #1
    cmp r2, #4096
    bne 1b
    mcr p15, 0, r0, c2, c0, 0   @ translation table base
    mov r0, #3
    mcr p15, 0, r0, c3, c0, 0   @ domain 0: use the table's permissions
    mrc p15, 0, r0, c1, c0, 0
    orr r0, r0, #0x00400000     @ allow unaligned access (ARMv6)
    orr r0, r0, #0x00000001     @ mapper on
    mcr p15, 0, r0, c1, c0, 0
    b _start
    .ltorg

@ Timer interrupt, used by the profiler (profile.inc): records where the
@ program was when the timer fired.
    .global pxt_qemu_irq
    .type pxt_qemu_irq, %function
pxt_qemu_irq:
    sub lr, lr, #4
    push {r0-r3, r12, lr}
    mov r0, lr
    bl prof_sample
    ldmfd sp!, {r0-r3, r12, pc}^
