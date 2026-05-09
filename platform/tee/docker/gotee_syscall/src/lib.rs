//! Safe Rust wrappers around GoTEE syscalls.
//!
//! This crate provides the interface between a Rust Trusted Applet and the
//! GoTEE Trusted OS running in ARM TrustZone Secure World system mode.
//!
//! Syscalls are issued via the ARM `swi 0` (software interrupt) instruction.
//! The syscall number is passed in `r0`, with arguments in `r1`–`r3`.

#![no_std]

use core::arch::asm;
use core::fmt::{self, Write};
use core::panic::PanicInfo;
use core::time::Duration;

// ---------------------------------------------------------------------------
// Syscall numbers (must match GoTEE monitor/syscall constants)
// ---------------------------------------------------------------------------

const SYS_EXIT: u32 = 0;
const SYS_WRITE: u32 = 1;
const SYS_NANOTIME: u32 = 2;
const SYS_GETRANDOM: u32 = 3;
const SYS_RPC_REQ: u32 = 4;
const SYS_RPC_RES: u32 = 5;

// ---------------------------------------------------------------------------
// Core syscall wrappers
// ---------------------------------------------------------------------------

/// Terminates the Trusted Applet. This does not return.
pub fn exit() -> ! {
    unsafe {
        asm!(
            "swi 0",
            in("r0") SYS_EXIT,
            options(noreturn),
        );
    }
}

/// Writes a single byte to the Trusted OS console output.
pub fn write_byte(b: u8) {
    unsafe {
        asm!(
            "swi 0",
            in("r0") SYS_WRITE,
            in("r1") b as u32,
        );
    }
}

/// Writes a string to the Trusted OS console output.
pub fn print(s: &str) {
    for b in s.bytes() {
        write_byte(b);
    }
}

/// Returns the current system time in nanoseconds.
pub fn nanotime() -> u64 {
    let ns_low: u32;
    let ns_high: u32;

    unsafe {
        asm!(
            "swi 0",
            in("r0") SYS_NANOTIME,
        );

        asm!(
            "",
            out("r0") ns_low,
            out("r1") ns_high,
        );
    }

    ((ns_high as u64) << 32) | (ns_low as u64)
}

/// Fills `buf` with cryptographically secure random bytes from the hardware RNG.
pub fn getrandom(buf: &mut [u8]) {
    unsafe {
        asm!(
            "swi 0",
            in("r0") SYS_GETRANDOM,
            in("r1") buf.as_ptr(),
            in("r2") buf.len(),
        );
    }
}

/// Sends an RPC request payload to the Trusted OS.
///
/// The Trusted OS will dispatch this to registered RPC handlers.
/// Call [`rpc_response`] afterward to read the reply.
pub fn rpc_request(data: &[u8]) {
    unsafe {
        asm!(
            "swi 0",
            in("r0") SYS_RPC_REQ,
            in("r1") data.as_ptr(),
            in("r2") data.len(),
        );
    }
}

/// Reads an RPC response from the Trusted OS into `buf`.
///
/// Returns the number of bytes written into `buf`.
pub fn rpc_response(buf: &mut [u8]) -> usize {
    let n: u32;

    unsafe {
        asm!(
            "swi 0",
            in("r0") SYS_RPC_RES,
            in("r1") buf.as_mut_ptr(),
            in("r2") buf.len(),
        );

        asm!(
            "",
            out("r0") n,
        );
    }

    n as usize
}

// ---------------------------------------------------------------------------
// Applet dispatch loop
// ---------------------------------------------------------------------------

/// Signature for a trusted-function handler.
///
/// - `method` — the method name the caller asked for
/// - `input`  — request payload (UTF-8 bytes, as delivered by the Trusted OS)
/// - `out`    — response buffer the handler writes into
///
/// Returns the number of bytes written to `out`.
pub type Handler = fn(method: &str, input: &[u8], out: &mut [u8]) -> usize;

/// Runs the applet dispatch loop. Never returns.
///
/// Each iteration asks the Trusted OS for the next queued request via
/// `RPC.Recv`, invokes `handler`, and ships the reply via `RPC.Send`.
///
/// A request with method `"__exit"` causes the applet to call [`exit`]
/// cleanly — the sentinel used by the Trusted OS to end the session.
pub fn serve(handler: Handler) -> ! {
    // Incoming request envelope + outgoing payload.
    let mut rpc_buf = [0u8; 4096];
    let mut out_buf = [0u8; 4096];

    loop {
        // 1. Long-poll for the next request.
        rpc_request(br#"{"method":"RPC.Recv","params":[false],"id":1}"#);
        let n = rpc_response(&mut rpc_buf);

        let json = core::str::from_utf8(&rpc_buf[..n]).unwrap_or("");
        let method = extract_json_string(json, "\"Method\":");
        let input = extract_json_string(json, "\"Input\":");

        if method == "__exit" {
            exit();
        }

        // 2. Dispatch to the user's handler.
        let n_out = handler(method, input.as_bytes(), &mut out_buf);
        let output = core::str::from_utf8(&out_buf[..n_out]).unwrap_or("");

        // 3. Ship the reply. Re-use rpc_buf as the send scratch.
        let mut send = JsonBuf::new();
        let _ = send.write_str(r#"{"method":"RPC.Send","params":[{"Output":"#);
        let _ = write_json_string(&mut send, output);
        let _ = send.write_str(r#"}],"id":2}"#);

        rpc_request(send.as_bytes());
        // Discard ack.
        rpc_response(&mut rpc_buf);
    }
}

// ---------------------------------------------------------------------------
// Tiny no-alloc JSON helpers (just enough for the dispatch envelope)
// ---------------------------------------------------------------------------

struct JsonBuf {
    buf: [u8; 1024],
    pos: usize,
}

impl JsonBuf {
    fn new() -> Self {
        Self {
            buf: [0u8; 1024],
            pos: 0,
        }
    }

    fn as_bytes(&self) -> &[u8] {
        &self.buf[..self.pos]
    }
}

impl Write for JsonBuf {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        let bytes = s.as_bytes();
        if self.pos + bytes.len() > self.buf.len() {
            return Err(fmt::Error);
        }
        self.buf[self.pos..self.pos + bytes.len()].copy_from_slice(bytes);
        self.pos += bytes.len();
        Ok(())
    }
}

fn write_json_string(w: &mut JsonBuf, s: &str) -> fmt::Result {
    w.write_str("\"")?;
    for b in s.bytes() {
        match b {
            b'"' => w.write_str("\\\"")?,
            b'\\' => w.write_str("\\\\")?,
            b'\n' => w.write_str("\\n")?,
            b'\r' => w.write_str("\\r")?,
            b'\t' => w.write_str("\\t")?,
            0x00..=0x1f => write!(w, "\\u{:04x}", b)?,
            _ => w.write_char(b as char)?,
        }
    }
    w.write_str("\"")
}

/// Returns the raw (still-escaped) slice of a JSON string value following the
/// given key. Good enough for ASCII payloads; callers needing binary should
/// use their own encoding.
fn extract_json_string<'a>(json: &'a str, key: &str) -> &'a str {
    let Some(key_pos) = json.find(key) else {
        return "";
    };
    let after_key = &json[key_pos + key.len()..];
    let Some(quote_start) = after_key.find('"') else {
        return "";
    };
    let content = &after_key[quote_start + 1..];
    let bytes = content.as_bytes();
    let mut end = 0;
    while end < bytes.len() {
        if bytes[end] == b'\\' {
            end += 2;
        } else if bytes[end] == b'"' {
            return &content[..end];
        } else {
            end += 1;
        }
    }
    ""
}

// ---------------------------------------------------------------------------
// Stdout adapter (enables write! / writeln! macros)
// ---------------------------------------------------------------------------

/// A zero-size type implementing `core::fmt::Write` via the `SYS_WRITE` syscall.
pub struct Stdout;

impl Write for Stdout {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        for b in s.bytes() {
            write_byte(b);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Convenience macros
// ---------------------------------------------------------------------------

/// Prints formatted text to the Trusted OS console.
#[macro_export]
macro_rules! print {
    ($($arg:tt)*) => {
        {
            use core::fmt::Write;
            write!(&mut $crate::Stdout, $($arg)*).ok();
        }
    };
}

/// Prints formatted text followed by a newline (`\r\n`) to the Trusted OS console.
#[macro_export]
macro_rules! println {
    () => {
        $crate::print!("\r\n")
    };
    ($($arg:tt)*) => {
        {
            use core::fmt::Write;
            write!(&mut $crate::Stdout, $($arg)*).ok();
            $crate::print!("\r\n");
        }
    };
}

/// Prints a timestamped log line to the Trusted OS console.
///
/// Format: `HH:MM:SS <message>\r\n`
#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => {
        {
            $crate::print_walltime($crate::nanotime());
            $crate::println!($($arg)*);
        }
    };
}

/// Prints a wall-clock timestamp prefix (HH:MM:SS) derived from nanotime.
#[doc(hidden)]
pub fn print_walltime(ns: u64) {
    let epoch = Duration::from_nanos(ns).as_secs();
    let ss = epoch % 60;
    let mm = (epoch / 60) % 60;
    let hh = (epoch / 3600) % 24;
    print!("{:02}:{:02}:{:02} ", hh, mm, ss);
}

// ---------------------------------------------------------------------------
// Panic handler
// ---------------------------------------------------------------------------

/// Global panic handler. Logs the panic info and exits the applet.
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    print_walltime(nanotime());
    print!("PANIC: ");
    if let Some(msg) = info.message().as_str() {
        print(msg);
    } else {
        use core::fmt::Write;
        write!(&mut Stdout, "{}", info).ok();
    }
    print("\r\n");
    exit();
}
