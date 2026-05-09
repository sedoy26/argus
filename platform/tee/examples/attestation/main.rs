//! Remote Attestation — Request a device-unique derived key from the Trusted OS.
//!
//! Exposes a single dispatch method over the bridge:
//!   {"Method":"Attest","Input":""} → hex-encoded derived key, or error string
//!
//! Upload to the device with `bun run upload` — this only touches the
//! applet, no Trusted OS rebuild or SD re-flash needed:
//!
//!   cp examples/attestation/main.rs src/main.rs
//!   make applet
//!   bun run upload target/armv7a-none-eabi/release/trusted_applet
//!
//! Then:
//!   printf '{"Method":"Attest","Input":""}\n' | nc 10.0.0.1 4000

#![no_std]
#![no_main]

use gotee_syscall::{self, log};

const ATTEST_REQ: &[u8] = br#"{"method":"RPC.Attest","params":[true],"id":1}"#;

fn handle(method: &str, _input: &[u8], out: &mut [u8]) -> usize {
    match method {
        "Attest" => {
            gotee_syscall::rpc_request(ATTEST_REQ);
            let mut resp = [0u8; 512];
            let n = gotee_syscall::rpc_response(&mut resp);

            // Pass the raw JSON reply through — callers on the host side
            // can parse DerivedKey / Error themselves.
            let k = n.min(out.len());
            out[..k].copy_from_slice(&resp[..k]);
            k
        }
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn _start() -> ! {
    log!("Attestation example ready");
    gotee_syscall::serve(handle)
}
