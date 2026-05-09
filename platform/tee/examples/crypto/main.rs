//! Crypto — Hardware random number generation demo.
//!
//! Exposes a single dispatch method over the bridge:
//!   {"Method":"Random","Input":"32"} → 32 hardware-random bytes as lowercase hex
//!
//! Upload to the device with `bun run upload` — this only touches the
//! applet, no Trusted OS rebuild or SD re-flash needed:
//!
//!   cp examples/crypto/main.rs src/main.rs
//!   make applet
//!   bun run upload target/armv7a-none-eabi/release/trusted_applet
//!
//! Then:
//!   printf '{"Method":"Random","Input":"16"}\n' | nc 10.0.0.1 4000

#![no_std]
#![no_main]

use gotee_syscall::{self, log};

fn handle(method: &str, input: &[u8], out: &mut [u8]) -> usize {
    match method {
        "Random" => {
            let s = core::str::from_utf8(input).unwrap_or("");
            let n: usize = s.trim().parse().unwrap_or(0);
            let n = n.min(64);

            let mut buf = [0u8; 64];
            gotee_syscall::getrandom(&mut buf[..n]);

            // hex-encode into out
            let need = n * 2;
            let w = need.min(out.len());
            for (i, b) in buf[..n].iter().enumerate() {
                if i * 2 + 1 >= w {
                    break;
                }
                out[i * 2] = nibble_hex(b >> 4);
                out[i * 2 + 1] = nibble_hex(b & 0x0f);
            }
            w
        }
        _ => 0,
    }
}

fn nibble_hex(n: u8) -> u8 {
    match n {
        0..=9 => b'0' + n,
        _ => b'a' + (n - 10),
    }
}

#[no_mangle]
pub extern "C" fn _start() -> ! {
    log!("Crypto example ready");
    gotee_syscall::serve(handle)
}
