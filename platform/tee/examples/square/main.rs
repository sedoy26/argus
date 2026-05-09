//! Square — parse an integer from the request, compute `x * x`, return it.
//!
//! See examples/square/README.md for the host-side HTTP wrapper and the
//! full upload / curl flow.

#![no_std]
#![no_main]

use core::fmt::Write;

use gotee_syscall::{self, log};

fn handle(method: &str, input: &[u8], out: &mut [u8]) -> usize {
    match method {
        "Square" => {
            let s = core::str::from_utf8(input).unwrap_or("");
            let x: i64 = s.trim().parse().unwrap_or(0);
            let y = x.saturating_mul(x);

            let mut tmp = [0u8; 21];
            let mut w = DecWriter::new(&mut tmp);
            let _ = write!(w, "{}", y);
            let len = w.len();

            let n = len.min(out.len());
            out[..n].copy_from_slice(&tmp[..n]);
            n
        }
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn _start() -> ! {
    log!("Square example ready");
    gotee_syscall::serve(handle)
}

// No-alloc integer formatter used by "Square" to render `i64` into a byte
// buffer without pulling in a heap.
struct DecWriter<'a> {
    buf: &'a mut [u8],
    pos: usize,
}

impl<'a> DecWriter<'a> {
    fn new(buf: &'a mut [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn len(&self) -> usize {
        self.pos
    }
}

impl<'a> Write for DecWriter<'a> {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        let bytes = s.as_bytes();
        let end = self.pos + bytes.len();
        if end > self.buf.len() {
            return Err(core::fmt::Error);
        }
        self.buf[self.pos..end].copy_from_slice(bytes);
        self.pos = end;
        Ok(())
    }
}
