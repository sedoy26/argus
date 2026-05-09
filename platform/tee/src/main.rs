//! Argus Trusted Applet — verified security-intelligence consensus engine.
//!
//! Runs inside ARM TrustZone Secure World (GoTEE Trusted OS, QEMU edition).
//! Watcher agents on the Normal World submit threat signals over the
//! TCP/JSON bridge on `127.0.0.1:4000`; this applet aggregates them per
//! contract address, computes a consensus risk score, and returns a
//! TEE-signed envelope that ENS / clients can later verify.
//!
//! See `platform/tee/CLAUDE.md` for the GoTEE bridge protocol and
//! `architecture-vision.md` §5.2 for the consensus design.
//!
//! ## Wire methods
//!
//!   {"Method":"BootInfo","Input":""}
//!     → {"boot_commitment":"0x..","code_hash":"0x..","boot_ts_ns":...}
//!
//!   {"Method":"Signal","Input":"SUBMIT|<addr>|<chain>|<threat>|<verdict>|<evhash>|<submitter>|<rep>|<ts>"}
//!     → consensus JSON for <addr>
//!
//!   {"Method":"Query","Input":"QUERY|<addr>"}        (or just "<addr>")
//!     → consensus JSON for <addr>
//!
//! Pipe-delimited input was chosen over JSON-in-JSON to avoid a no_std
//! JSON parser; the Normal World host owns formatting.
//!
//! ## Attestation (QEMU caveat)
//!
//! Real `RPC.Attest` returns Error under emulation (no DCP/CAAM). We
//! emulate the trust property as follows:
//!   1. At boot, fill BOOT_SECRET (32 B) from `getrandom`.
//!   2. Print BOOT_COMMITMENT = sha256("argus-boot-v1" || BOOT_SECRET) to
//!      the Trusted OS console — anyone watching boot logs records this.
//!   3. Each consensus envelope ships an attestation tag
//!      sha256("argus-attest-v1" || BOOT_SECRET || canonical_fields ||
//!             CODE_HASH). A verifier with BOOT_COMMITMENT cannot forge
//!      it without BOOT_SECRET, but trusts that the attested code (the
//!      open-source applet whose hash is logged) produced it.
//!   On real hardware this is replaced with an Ed25519 keypair plus
//!   `RPC.Attest`-derived KDF — see `docs/PORTING_TO_USBARMORY.md`.

#![no_std]
#![no_main]
// Static-mut access from a single-threaded applet is intentional here; the
// GoTEE bridge serializes calls. Silence the recent nightly lint.
#![allow(static_mut_refs)]

use gotee_syscall::{self, getrandom, log, nanotime};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Build-time identity
//
// `CODE_HASH = sha256(CODE_HASH_INPUT)` is the Argus equivalent of a
// remote-attestation code hash. Bump the literal whenever the applet
// logic changes meaningfully.
// ---------------------------------------------------------------------------

const CODE_HASH_INPUT: &str = "argus-applet-v0.1-dev";

// ---------------------------------------------------------------------------
// Capacity (static .bss budget ≈ 256 × 150 B ≈ 38 KB)
// ---------------------------------------------------------------------------

const MAX_SIGNALS: usize = 256;
const MAX_OUT: usize = 1024;
const MAX_SAMPLES_REPORTED: usize = 8;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Verdict {
    Unknown,
    Unconfirmed,
    Confirmed,
    Disputed,
}

impl Verdict {
    fn parse(s: &str) -> Self {
        match s {
            "UNCONFIRMED" => Verdict::Unconfirmed,
            "CONFIRMED" => Verdict::Confirmed,
            "DISPUTED" => Verdict::Disputed,
            _ => Verdict::Unknown,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Verdict::Confirmed => "CONFIRMED",
            Verdict::Unconfirmed => "UNCONFIRMED",
            Verdict::Disputed => "DISPUTED",
            Verdict::Unknown => "UNKNOWN",
        }
    }
}

#[derive(Clone, Copy)]
struct SignalRec {
    addr: [u8; 20],
    chain_id: u32,
    threat_type: [u8; 16], // ASCII, NUL-padded
    verdict: Verdict,
    evidence_hash: [u8; 32],
    submitter: [u8; 64], // ASCII, NUL-padded
    rep: u8,
    ts: u64,
    valid: bool,
}

impl SignalRec {
    const fn empty() -> Self {
        Self {
            addr: [0; 20],
            chain_id: 0,
            threat_type: [0; 16],
            verdict: Verdict::Unknown,
            evidence_hash: [0; 32],
            submitter: [0; 64],
            rep: 0,
            ts: 0,
            valid: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Static state
//
// The applet is single-threaded by construction (the Trusted OS bridge
// serializes calls into one applet goroutine, see CLAUDE.md →
// "Concurrency"), so plain `static mut` access from `unsafe` blocks is
// race-free.
// ---------------------------------------------------------------------------

static mut BOOT_SECRET: [u8; 32] = [0; 32];
static mut BOOT_COMMITMENT: [u8; 32] = [0; 32];
static mut CODE_HASH: [u8; 32] = [0; 32];
static mut BOOT_TS: u64 = 0;
static mut SIGNALS: [SignalRec; MAX_SIGNALS] = [SignalRec::empty(); MAX_SIGNALS];
static mut SIGNAL_COUNT: usize = 0;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

fn boot_init() {
    unsafe {
        getrandom(&mut BOOT_SECRET);
        BOOT_TS = nanotime();

        let mut h = Sha256::new();
        h.update(b"argus-boot-v1\x00");
        h.update(&BOOT_SECRET);
        BOOT_COMMITMENT.copy_from_slice(&h.finalize());

        let mut h = Sha256::new();
        h.update(CODE_HASH_INPUT.as_bytes());
        CODE_HASH.copy_from_slice(&h.finalize());
    }
}

// ---------------------------------------------------------------------------
// no_std byte buffer + writers
// ---------------------------------------------------------------------------

struct Buf<'a> {
    buf: &'a mut [u8],
    pos: usize,
}

impl<'a> Buf<'a> {
    fn new(buf: &'a mut [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn push(&mut self, b: u8) -> Result<(), ()> {
        if self.pos >= self.buf.len() {
            return Err(());
        }
        self.buf[self.pos] = b;
        self.pos += 1;
        Ok(())
    }

    fn write_bytes(&mut self, s: &[u8]) -> Result<(), ()> {
        for &b in s {
            self.push(b)?;
        }
        Ok(())
    }

    fn write_str(&mut self, s: &str) -> Result<(), ()> {
        self.write_bytes(s.as_bytes())
    }

    fn write_u64(&mut self, n: u64) -> Result<(), ()> {
        if n == 0 {
            return self.push(b'0');
        }
        let mut tmp = [0u8; 20];
        let mut i = 20;
        let mut x = n;
        while x > 0 {
            i -= 1;
            tmp[i] = b'0' + (x % 10) as u8;
            x /= 10;
        }
        self.write_bytes(&tmp[i..])
    }

    fn write_hex(&mut self, bytes: &[u8]) -> Result<(), ()> {
        for &b in bytes {
            self.push(nibble_hex(b >> 4))?;
            self.push(nibble_hex(b & 0x0f))?;
        }
        Ok(())
    }

    fn len(&self) -> usize {
        self.pos
    }
}

fn nibble_hex(n: u8) -> u8 {
    if n < 10 {
        b'0' + n
    } else {
        b'a' + (n - 10)
    }
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn parse_hex_into(s: &str, out: &mut [u8]) -> Option<()> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = s.as_bytes();
    if bytes.len() != out.len() * 2 {
        return None;
    }
    for i in 0..out.len() {
        let h = hex_val(bytes[i * 2])?;
        let l = hex_val(bytes[i * 2 + 1])?;
        out[i] = (h << 4) | l;
    }
    Some(())
}

fn nul_trim(b: &[u8]) -> &[u8] {
    let n = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    &b[..n]
}

// ---------------------------------------------------------------------------
// Signal parsing (pipe-delimited)
// ---------------------------------------------------------------------------

fn parse_signal(line: &str) -> Option<SignalRec> {
    // SUBMIT|<addr>|<chain>|<threat>|<verdict>|<evhash>|<submitter>|<rep>|<ts>
    let mut parts = line.split('|');
    if parts.next()? != "SUBMIT" {
        return None;
    }
    let addr_s = parts.next()?;
    let chain_s = parts.next()?;
    let threat_s = parts.next()?;
    let verdict_s = parts.next()?;
    let evhash_s = parts.next()?;
    let submitter_s = parts.next()?;
    let rep_s = parts.next()?;
    let ts_s = parts.next()?;

    let mut rec = SignalRec::empty();
    parse_hex_into(addr_s, &mut rec.addr)?;
    rec.chain_id = chain_s.parse().ok()?;

    let tb = threat_s.as_bytes();
    let tn = tb.len().min(rec.threat_type.len());
    rec.threat_type[..tn].copy_from_slice(&tb[..tn]);

    rec.verdict = Verdict::parse(verdict_s);

    parse_hex_into(evhash_s, &mut rec.evidence_hash)?;

    let sb = submitter_s.as_bytes();
    let sn = sb.len().min(rec.submitter.len());
    rec.submitter[..sn].copy_from_slice(&sb[..sn]);

    rec.rep = rep_s.parse().ok()?;
    rec.ts = ts_s.parse().ok()?;
    rec.valid = true;
    Some(rec)
}

fn parse_addr(s: &str) -> Option<[u8; 20]> {
    let mut a = [0u8; 20];
    parse_hex_into(s, &mut a)?;
    Some(a)
}

// ---------------------------------------------------------------------------
// Storage — single-threaded `static mut`
// ---------------------------------------------------------------------------

/// Insert a signal. Dedupe key is (addr, threat_type, submitter): a re-submission
/// from the same submitter for the same finding overwrites the prior entry
/// rather than counting twice.
unsafe fn store_signal(rec: &SignalRec) {
    for i in 0..SIGNAL_COUNT {
        let s = &SIGNALS[i];
        if s.valid
            && s.addr == rec.addr
            && s.threat_type == rec.threat_type
            && s.submitter == rec.submitter
        {
            SIGNALS[i] = *rec;
            return;
        }
    }
    if SIGNAL_COUNT < MAX_SIGNALS {
        SIGNALS[SIGNAL_COUNT] = *rec;
        SIGNAL_COUNT += 1;
    }
    // If full, silently drop. Fine for the demo; production would evict
    // by oldest-ts or by lowest-reputation.
}

// ---------------------------------------------------------------------------
// Consensus
// ---------------------------------------------------------------------------

#[derive(Default, Clone, Copy)]
struct Consensus {
    score: u8, // 0=NONE 1=YELLOW 2=ORANGE 3=RED 4=CRITICAL
    confidence: u8,
    count: u16,
    confirmed: u16,
    last_ts: u64,
}

unsafe fn compute_consensus(addr: &[u8; 20]) -> (Consensus, [SignalRec; MAX_SAMPLES_REPORTED], usize) {
    let mut c = Consensus::default();
    let mut samples = [SignalRec::empty(); MAX_SAMPLES_REPORTED];
    let mut sample_n = 0usize;
    let mut rep_sum: u32 = 0;
    let mut seen_subs = [[0u8; 64]; 16];
    let mut n_seen = 0usize;

    for i in 0..SIGNAL_COUNT {
        let s = &SIGNALS[i];
        if !s.valid || &s.addr != addr {
            continue;
        }
        c.count += 1;
        if s.ts > c.last_ts {
            c.last_ts = s.ts;
        }
        if s.verdict == Verdict::Confirmed {
            let mut already = false;
            for k in 0..n_seen {
                if seen_subs[k] == s.submitter {
                    already = true;
                    break;
                }
            }
            if !already && n_seen < seen_subs.len() {
                seen_subs[n_seen] = s.submitter;
                n_seen += 1;
                c.confirmed += 1;
                rep_sum += s.rep as u32;
            }
        }
        if sample_n < samples.len() {
            samples[sample_n] = *s;
            sample_n += 1;
        }
    }

    c.score = if c.confirmed >= 3 {
        4
    } else if c.confirmed >= 2 {
        3
    } else if c.confirmed >= 1 {
        2
    } else if c.count >= 1 {
        1
    } else {
        0
    };
    c.confidence = if rep_sum > 100 { 100 } else { rep_sum as u8 };
    (c, samples, sample_n)
}

fn score_label(s: u8) -> &'static str {
    match s {
        4 => "CRITICAL",
        3 => "RED",
        2 => "ORANGE",
        1 => "YELLOW",
        _ => "NONE",
    }
}

// ---------------------------------------------------------------------------
// Output formatting + attestation
// ---------------------------------------------------------------------------

unsafe fn write_consensus_json(
    out: &mut Buf,
    addr: &[u8; 20],
    c: &Consensus,
    samples: &[SignalRec],
    sample_n: usize,
    now_ns: u64,
) -> Result<(), ()> {
    out.write_str("{\"score\":\"")?;
    out.write_str(score_label(c.score))?;
    out.write_str("\",\"confidence\":")?;
    out.write_u64(c.confidence as u64)?;
    out.write_str(",\"count\":")?;
    out.write_u64(c.count as u64)?;
    out.write_str(",\"confirmed\":")?;
    out.write_u64(c.confirmed as u64)?;
    out.write_str(",\"addr\":\"0x")?;
    out.write_hex(addr)?;
    out.write_str("\",\"summary\":\"")?;
    let mut first = true;
    for i in 0..sample_n {
        let s = &samples[i];
        if !first {
            out.push(b',')?;
        }
        first = false;
        out.write_bytes(nul_trim(&s.threat_type))?;
        out.push(b':')?;
        out.write_str(s.verdict.as_str())?;
    }
    out.write_str("\",\"last_signal_ts\":")?;
    out.write_u64(c.last_ts)?;
    out.write_str(",\"applet_ts_ns\":")?;
    out.write_u64(now_ns)?;
    out.write_str(",\"code_hash\":\"0x")?;
    out.write_hex(&CODE_HASH)?;
    out.write_str("\",\"boot_commitment\":\"0x")?;
    out.write_hex(&BOOT_COMMITMENT)?;
    out.write_str("\",\"attestation\":\"0x")?;
    out.write_hex(&compute_attestation(addr, c, now_ns))?;
    out.write_str("\"}")?;
    Ok(())
}

unsafe fn compute_attestation(addr: &[u8; 20], c: &Consensus, now_ns: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"argus-attest-v1");
    h.update(&BOOT_SECRET);
    h.update(score_label(c.score).as_bytes());
    h.update(addr);
    h.update(&(c.count as u32).to_be_bytes());
    h.update(&(c.confirmed as u32).to_be_bytes());
    h.update(&c.confidence.to_be_bytes());
    h.update(&c.last_ts.to_be_bytes());
    h.update(&now_ns.to_be_bytes());
    h.update(&CODE_HASH);
    let mut out = [0u8; 32];
    out.copy_from_slice(&h.finalize());
    out
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

fn handle_boot_info(out: &mut [u8]) -> usize {
    let mut buf = Buf::new(out);
    let _ = buf.write_str("{\"boot_commitment\":\"0x");
    unsafe { let _ = buf.write_hex(&BOOT_COMMITMENT); }
    let _ = buf.write_str("\",\"code_hash\":\"0x");
    unsafe { let _ = buf.write_hex(&CODE_HASH); }
    let _ = buf.write_str("\",\"code_hash_input\":\"");
    let _ = buf.write_str(CODE_HASH_INPUT);
    let _ = buf.write_str("\",\"boot_ts_ns\":");
    unsafe { let _ = buf.write_u64(BOOT_TS); }
    let _ = buf.write_str(",\"now_ns\":");
    let _ = buf.write_u64(nanotime());
    let _ = buf.write_str(",\"signal_count\":");
    unsafe { let _ = buf.write_u64(SIGNAL_COUNT as u64); }
    let _ = buf.write_str(",\"max_signals\":");
    let _ = buf.write_u64(MAX_SIGNALS as u64);
    let _ = buf.write_str("}");
    buf.len()
}

fn handle_signal(input: &str, out: &mut [u8]) -> usize {
    let line = input.trim();
    if !line.starts_with("SUBMIT|") {
        return error_out(out, "expected SUBMIT|... prefix");
    }
    let Some(rec) = parse_signal(line) else {
        return error_out(out, "malformed SUBMIT line");
    };
    unsafe {
        store_signal(&rec);
    }
    let (cons, samples, sn) = unsafe { compute_consensus(&rec.addr) };
    let now = nanotime();
    let mut buf = Buf::new(out);
    let _ = unsafe { write_consensus_json(&mut buf, &rec.addr, &cons, &samples, sn, now) };
    buf.len()
}

fn handle_query(input: &str, out: &mut [u8]) -> usize {
    let s = input.trim();
    let s = s.strip_prefix("QUERY|").unwrap_or(s);
    let Some(addr) = parse_addr(s) else {
        return error_out(out, "bad address");
    };
    let (cons, samples, sn) = unsafe { compute_consensus(&addr) };
    let now = nanotime();
    let mut buf = Buf::new(out);
    let _ = unsafe { write_consensus_json(&mut buf, &addr, &cons, &samples, sn, now) };
    buf.len()
}

fn error_out(out: &mut [u8], msg: &str) -> usize {
    let mut b = Buf::new(out);
    let _ = b.write_str("{\"error\":\"");
    let _ = b.write_str(msg);
    let _ = b.write_str("\"}");
    b.len()
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

fn handle(method: &str, input: &[u8], out: &mut [u8]) -> usize {
    let n = out.len().min(MAX_OUT);
    let out = &mut out[..n];
    match method {
        "BootInfo" => handle_boot_info(out),
        "Signal" => handle_signal(core::str::from_utf8(input).unwrap_or(""), out),
        "Query" => handle_query(core::str::from_utf8(input).unwrap_or(""), out),
        _ => 0,
    }
}

fn log_hex(label: &str, bytes: &[u8]) {
    let mut hex = [0u8; 128];
    let n = {
        let mut buf = Buf::new(&mut hex);
        let _ = buf.write_hex(bytes);
        buf.len()
    };
    if let Ok(s) = core::str::from_utf8(&hex[..n]) {
        log!("{} 0x{}", label, s);
    }
}

#[no_mangle]
pub extern "C" fn _start() -> ! {
    boot_init();
    log!(
        "Argus consensus engine v0.1 (max_signals={}, code_hash_input={})",
        MAX_SIGNALS,
        CODE_HASH_INPUT
    );
    unsafe {
        log_hex("BOOT_COMMITMENT", &BOOT_COMMITMENT);
        log_hex("CODE_HASH", &CODE_HASH);
    }
    gotee_syscall::serve(handle)
}
