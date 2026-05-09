# GoTEE Rust Starter — QEMU edition

Write Rust code that runs inside ARM TrustZone **Secure World**, with no
hardware required. The Trusted OS boots in [QEMU](https://www.qemu.org)
inside a Docker container; your Rust applet talks to the world over a
single TCP/JSON bridge on `127.0.0.1:4000`.

This branch is the QEMU distribution. For the same kit running on real
[USB Armory MK II](https://github.com/usbarmory/usbarmory/wiki) hardware
— same applet code, same bridge, same syscall ABI, just over USB-CDC-ECM
at `10.0.0.1:4000` — see [`docs/PORTING_TO_USBARMORY.md`](docs/PORTING_TO_USBARMORY.md).
A hackathon team can run both side-by-side: the same `src/main.rs` works
in either edition.

## Prerequisites

- [Docker](https://www.docker.com/) (Desktop on Mac, Engine on Linux) —
  the only thing the QEMU edition strictly needs.
- [Rust](https://rustup.rs/) — pinned to nightly via `rust-toolchain.toml`,
  used to build the applet on the host.
- ARM bare-metal binutils — provides `arm-none-eabi-ld`, the linker Cargo
  invokes for the `armv7a-none-eabi` target. Not bundled with rustup.
  - Debian/Ubuntu: `sudo apt install binutils-arm-none-eabi`
  - Fedora: `sudo dnf install arm-none-eabi-binutils-cs`
  - Arch: `sudo pacman -S arm-none-eabi-binutils`
  - macOS: `brew install --cask gcc-arm-embedded`
- `nc` (BSD netcat) — preinstalled on macOS; `sudo apt install netcat-openbsd`
  on Debian/Ubuntu. Used for one-line bridge probes.
- [Bun](https://bun.sh/) — *optional*, only needed for `bun run upload`
  and `bun test`. Any TCP-capable language can talk to the bridge.

## Quick Start

```bash
# 1. Boot the emulator (blocks the shell with QEMU's console output)
make qemu

# In another shell:
# 2. Talk to the default applet
printf '{"Method":"Echo","Input":"hi"}\n' | nc 127.0.0.1 4000
# {"Output":"hi"}
```

That's the whole stack working: your shell → Docker port-forward → emulated
FEC ENET → Trusted OS → Rust applet in Secure World → reply.

The first `make qemu` builds two Docker images (~5 min — TamaGo compiles
from source); subsequent runs reuse the cached images and start in seconds.

## Writing a trusted function

`src/main.rs` is the only file you edit. Add match arms to `handle` for
each trusted operation you want to expose:

```rust
fn handle(method: &str, input: &[u8], out: &mut [u8]) -> usize {
    match method {
        "Echo" => {
            let n = input.len().min(out.len());
            out[..n].copy_from_slice(&input[..n]);
            n
        }
        // "Sign" => { ... gotee_syscall::getrandom(&mut key) ... }
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn _start() -> ! {
    gotee_syscall::serve(handle)
}
```

`serve()` long-polls the Trusted OS for the next request, calls `handle`,
and ships the reply.

## Hot-swap: change the applet without restarting the emulator

```bash
$EDITOR src/main.rs
make applet
bun run upload
# → ok, swapping — Trusted OS terminates the running applet, loads
#   the new ELF, starts it. Takes ~50 ms; the bridge stays up
#   throughout. The QEMU guest does NOT restart.
```

`scripts/upload.ts` base64-encodes the ELF and POSTs it to the bridge's
`__upload` method. The Trusted OS validates the ELF header, terminates
the running applet via the `__exit` sentinel, and loads the replacement
in-process. If the new applet panics or fails to load, the next boot
falls back to the embedded default — the device self-recovers.

(The uploader uses Bun because it's a one-file script, but any language
that can open a TCP socket works. See the [bridge protocol](#bridge-protocol)
below.)

> Note: hot-swapped applets live in RAM only — they don't survive a `make
> qemu` restart. To bake a new applet into the boot ELF (so the embedded
> default matches your code), rebuild: `make trusted_os && make qemu`.

## Bridge protocol

The Trusted OS exposes a single newline-delimited JSON TCP listener on
`127.0.0.1:4000` (the QEMU container publishes the guest's `10.0.0.1:4000`
listener as `127.0.0.1:4000` on the host):

```
→ {"Method":"Echo","Input":"hi"}
← {"Output":"hi"}

→ {"Method":"__upload","Input":"<base64 ELF>"}
← {"Output":"ok, swapping"}
```

Any `Method` other than `__upload` is forwarded verbatim to your applet's
`handle()`.

## How it works

```
┌─────────────────── Docker container (gotee-qemu) ──────────────────┐
│                                                                    │
│  qemu-system-arm -M mcimx6ul-evk                                   │
│  ┌──────────── Emulated USB Armory-class i.MX6UL SoC ────────────┐ │
│  │ Secure World (TrustZone)                                      │ │
│  │ ┌───────────────────────────────────────────────────────────┐ │ │
│  │ │  Trusted OS  (Go/TamaGo, system mode)                     │ │ │
│  │ │   - Hardware init, syscall dispatch                       │ │ │
│  │ │   - TCP JSON bridge on :4000 (FEC ENET)                   │ │ │
│  │ │   - SSH console on :22                                    │ │ │
│  │ ├───────────────────────────────────────────────────────────┤ │ │
│  │ │  Trusted Applet  (Rust, user mode)                        │ │ │
│  │ │   - YOUR CODE (src/main.rs)                               │ │ │
│  │ │   - Uses gotee_syscall crate                              │ │ │
│  │ └───────────────────────────────────────────────────────────┘ │ │
│  │                                                               │ │
│  │ Normal World: unused in this starter                          │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                          ▲                                         │
│                          │ -nic user,hostfwd=tcp::4000-10.0.0.1:4000│
└──────────────────────────┼─────────────────────────────────────────┘
                           │
              127.0.0.1:4000 on the host
```

The **Trusted OS** (`docker/trusted_os/`) is a Go unikernel compiled with
[TamaGo](https://github.com/usbarmory/tamago) targeting the `mx6ullevk`
board package — same i.MX6UL SoC that's on the USB Armory, but with
QEMU-friendly peripheral wiring.

The **Trusted Applet** (`src/main.rs`) runs in Secure World *user mode*
and talks to the Trusted OS via syscalls provided by the `gotee_syscall`
crate.

## Project structure

```
gotee_starter/
├── src/main.rs              ← your applet (edit this)
├── examples/
│   ├── blinky/              ← LED control (no visible output under QEMU)
│   ├── crypto/              ← hardware RNG
│   ├── attestation/         ← remote attestation (Error path under QEMU)
│   └── square/              ← x² applet + Bun HTTP shim (own README)
├── scripts/
│   ├── qemu.sh              ← launches the emulator container
│   ├── make-sd-img.sh       ← creates the file-backed SD image
│   └── upload.ts            ← applet uploader (Bun, used for hot-swap)
├── docker/                  ← image-building pipeline (Rust, Go, QEMU)
│   ├── Dockerfile           ← Trusted OS builder (TamaGo + binutils)
│   ├── qemu/Dockerfile      ← runtime image (qemu-system-arm)
│   ├── qemu/run.sh          ← in-container auto-restart wrapper
│   ├── Makefile
│   ├── Cargo.toml
│   ├── gotee_syscall/
│   ├── trusted_os/
│   └── applet.ld
├── docs/
│   └── PORTING_TO_USBARMORY.md  ← run on real hardware
├── Makefile                 ← thin wrapper that delegates to docker/
└── package.json             ← bun run upload, bun test
```

## Examples

Copy one over `src/main.rs`, `make applet`, upload. Each example is a
complete working applet, driven over the bridge with `nc` (no webserver
required).

| Example        | RPC method | Description                                          |
|----------------|------------|------------------------------------------------------|
| `blinky/`      | `Blink`    | "Toggles" the blue LED N times — no GPIO under QEMU, just a log line |
| `crypto/`      | `Random`   | Return N bytes from the hardware RNG                 |
| `attestation/` | `Attest`   | Return a hardware-derived attestation key (Error path under QEMU) |
| `square/`      | `Square`   | `x → x²`, wrapped in a Bun HTTP shim — see [`examples/square/README.md`](examples/square/README.md) |

```bash
printf '{"Method":"Blink","Input":"3"}\n' | nc 127.0.0.1 4000
```

## Testing

All examples have automated tests that run against the live QEMU
emulator and verify behavior:

```bash
make qemu                       # in shell A: keep the emulator running
bun test                        # in shell B: ~25 s
```

Covered:
- `examples/square/` — arithmetic correctness + i64 saturation
- `examples/crypto/` — RNG output shape + entropy between successive calls
- `examples/attestation/` — verifies the bridge round-trip + the
  emulation Error path (no DCP/CAAM in QEMU)

Not covered:
- `examples/blinky/` — no visible LED. After running the tests, your
  `src/main.rs` is whatever the last test wrote there; `git checkout
  src/main.rs` to restore the starter.

## What's emulated vs degraded under QEMU

| Feature         | QEMU edition                         | Hardware (porting guide) |
|-----------------|--------------------------------------|--------------------------|
| Bridge          | TCP on 127.0.0.1:4000 via `hostfwd`  | TCP on 10.0.0.1:4000 via USB-CDC-ECM |
| Applet hot-swap | In-process: applet ELF held in RAM   | Persistent: written to SD, WDOG reset |
| `RPC.Echo`      | Works                                | Works |
| `RPC.LED`       | Logs "blue=on/off" to console        | Drives the actual blue LED |
| `RPC.Attest`    | Returns Error (no DCP/CAAM)          | Returns DerivedKey (16 B on ULL DCP, 32 B on UL CAAM) |
| RNG             | Works (TamaGo runtime RNG)           | Works (RNGB hardware) |
| TrustZone       | Real (QEMU emulates the SoC)         | Real |

## Syscalls

The `gotee_syscall` crate provides:

| Function                               | Description                               |
|----------------------------------------|-------------------------------------------|
| `serve(handler)`                       | Run the applet dispatch loop              |
| `println!(...)` / `log!(...)`          | Print to the Trusted OS console           |
| `exit()`                               | Terminate the applet                      |
| `nanotime() -> u64`                    | System time in nanoseconds                |
| `getrandom(&mut buf)`                  | Hardware random bytes                     |
| `rpc_request(&data)` / `rpc_response(&mut buf)` | Raw JSON-RPC into the Trusted OS |

## RPC services (Trusted OS → applet)

The applet can call these methods on the Trusted OS:

| Method       | Description                                 |
|--------------|---------------------------------------------|
| `RPC.Echo`   | Returns the input string (diagnostic)       |
| `RPC.LED`    | Controls the blue LED (logged only on QEMU) |
| `RPC.Attest` | Returns a hardware-derived attestation key (Error on QEMU) |

## Resources

- [GoTEE](https://github.com/usbarmory/GoTEE) — TEE framework this is built on
- [GoTEE-example](https://github.com/usbarmory/GoTEE-example) — upstream reference
- [TamaGo](https://github.com/usbarmory/tamago) — bare-metal Go for ARM
- [tamago-example](https://github.com/usbarmory/tamago-example) — the
  network/FEC pattern this kit cribs from for QEMU
- [QEMU mcimx6ul-evk machine docs](https://www.qemu.org/docs/master/system/arm/mcimx6ul-evk.html)
- [USB Armory Wiki](https://github.com/usbarmory/usbarmory/wiki)
- [Embedded Rust Book](https://docs.rust-embedded.org/book/)

## License

Based on [GoTEE-example](https://github.com/usbarmory/GoTEE-example) by
the GoTEE Authors. See `LICENSE`.
