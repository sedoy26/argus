/*
 * Linker script for the Rust Trusted Applet.
 *
 * The applet is loaded into the BEE alias region at 0x10000000 by the
 * GoTEE Trusted OS. The text section starts at 0x10010000 (0x10000 offset
 * reserved for the ELF header and GoTEE metadata).
 *
 * Memory layout (see trusted_os/mem.go and GoTEE-example mem/layout_arm.go):
 *   Applet virtual:   0x10000000 – 0x12000000 (32 MB, BEE alias)
 *   Trusted OS:        0x90000000 – 0x95f00000 (95 MB)
 *   Non-Secure:        0x80000000 – 0x90000000 (256 MB)
 */

ENTRY(_start)

SECTIONS
{
    . = 0x10010000;

    .text : {
        KEEP(*(.text._start))
        *(.text .text.*)
    }

    .rodata : ALIGN(4) {
        *(.rodata .rodata.*)
    }

    .data : ALIGN(4) {
        *(.data .data.*)
    }

    .bss (NOLOAD) : ALIGN(4) {
        __bss_start = .;
        *(.bss .bss.*)
        *(COMMON)
        __bss_end = .;
    }

    /DISCARD/ : {
        *(.ARM.exidx*)
        *(.ARM.attributes*)
        *(.comment)
        *(.note*)
    }
}
