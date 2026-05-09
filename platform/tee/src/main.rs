//! Starter applet — the default `src/main.rs` you edit.
//!
//! Ships a single dispatch method as a "stack working" smoke test:
//!   {"Method":"Echo","Input":"hi"} → {"Output":"hi"}
//!
//! Add your own methods by extending the `match` in `handle()`. Hot-swap
//! without re-flashing:
//!
//!   make applet
//!   bun run upload target/armv7a-none-eabi/release/trusted_applet
//!
//! See examples/ for richer applets (LED, hardware RNG, attestation).

#![no_std]
#![no_main]

use gotee_syscall::{self, log};

fn handle(method: &str, input: &[u8], out: &mut [u8]) -> usize {
    match method {
        "Echo" => {
            let n = input.len().min(out.len());
            out[..n].copy_from_slice(&input[..n]);
            n
        }
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn _start() -> ! {
    log!("Starter applet ready");
    gotee_syscall::serve(handle)
}
