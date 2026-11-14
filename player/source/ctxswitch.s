@ Fiber context switch for the MakeCode runtime (ARM11, hard-float).
    .arch armv6k
    .fpu vfp
    .arm
    .text

@ void pxt3ds_switch(void **saveSp, void *loadSp)
@ Saves the callee-saved registers of the running fiber on its stack, stores
@ its stack pointer in *saveSp, then resumes the fiber whose saved stack
@ pointer is loadSp.
    .global pxt3ds_switch
    .type pxt3ds_switch, %function
pxt3ds_switch:
    push {r3-r11, lr}       @ r3 is only there to keep the stack 8-byte aligned
    vpush {d8-d15}
    str sp, [r0]
    mov sp, r1
    vpop {d8-d15}
    pop {r3-r11, lr}
    bx lr

@ First code a new fiber runs: its initial frame puts the entry function in
@ r4 and its argument in r5.
    .global pxt3ds_fiber_boot
    .type pxt3ds_fiber_boot, %function
pxt3ds_fiber_boot:
    mov r0, r5
    blx r4
1:  b 1b                    @ the entry function never returns
