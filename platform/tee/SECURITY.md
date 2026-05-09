# Security model (QEMU edition)

This is a **hackathon starter kit**, not a production trusted-execution
platform. The threat model is "developer with the emulator on their
desk, learning TrustZone fundamentals." Many simplifications here would
be unacceptable in a deployed product. They are listed here so you know
what's missing if you decide to build something serious on top.

This branch runs the Trusted OS in QEMU; the threat model below reflects
that. For the equivalent analysis when running on real USB Armory MK II
hardware, see [`docs/PORTING_TO_USBARMORY.md`](docs/PORTING_TO_USBARMORY.md)
and the `SECURITY.md` on the `main` branch.

## Threat model (what's protected, what isn't)

**Protected**
- The Trusted Applet runs in TrustZone Secure World user mode under the
  GoTEE monitor. The applet's text/data live at `0x10000000`–`0x12000000`
  via an MMU alias of physical `0x96000000` (`docker/trusted_os/mem.go`).
  TrustZone partitioning is real even under QEMU — the SoC emulation
  models it.
- Compromised host-side userland tools cannot directly read the applet's
  memory. They can only call its bridge methods.
- The applet has no filesystem, no networking, and no syscalls beyond
  the six in `docker/gotee_syscall/src/lib.rs`. Side-channel surface is
  minimal.

**Not protected**
- **Anyone with `127.0.0.1:4000` access can call any bridge method**,
  including `__upload` to swap the applet. The QEMU container publishes
  the port on the loopback interface only, so this means any local
  process. There is no authentication.
- **Anyone who can read/write `bin/trusted_os.elf` on the host can
  replace the Trusted OS** between `make qemu` invocations. The ELF
  isn't signed; nothing inside the QEMU guest validates it.
- The Trusted OS itself is trusted. Bugs in Go/TamaGo, GoTEE, the
  bridge, or the FEC driver become applet-visible.

## Audit findings

### M-1. Bridge has no authentication

`docker/trusted_os/bridge.go` exposes a TCP listener on
`10.0.0.1:4000` inside the QEMU guest, published to `127.0.0.1:4000`
on the host. Any local process can call any method, including:

- `__upload` — replaces the running applet with arbitrary code via
  in-process swap.
- Any RPC the applet exposes (RNG, derived keys, etc.).

**By design** for a hackathon flow that revolves around `bun run
upload …`. If you adapt this for any real deployment, add a
shared-secret-token check or mTLS *before* the bridge dispatch.

### M-2. SSH server allows passwordless login

`docker/trusted_os/main.go` — `ssh.ServerConfig{NoClientAuth: true}`.
Today the shell just echoes input, so functionally it's harmless. It
becomes a real exposure the moment someone adds privileged commands to
that shell. The container forwards SSH to `127.0.0.1:2222`, so this is
loopback-only.

### L-3. Applet ELF validation is structural, not semantic

`validateAppletELF` (`docker/trusted_os/bridge.go`) checks:

- ELF magic (`0x7F 'E' 'L' 'F'`)
- 32-bit class
- ARM machine type

It does **not** verify the entry point lands inside `.text`, that all
loadable segments fit within the applet region, or that the binary is
signed. A malformed-but-valid-looking ELF can fault at runtime.
Mitigation under QEMU: a hot-swap that fails leaves the previous
applet's state — but if the new applet has loaded into the region,
the old applet's pages may be partially overwritten. A `make qemu`
restart restores the embedded default.

### L-4. Build supply chain has no checksum verification

- `docker/Dockerfile` — `wget` from `go.dev` without SHA256
  verification.
- `docker/Dockerfile` — `git clone --depth 1 -b latest` of TamaGo's
  `latest` branch (no commit pin → builds aren't reproducible across
  time).
- `docker/Dockerfile` — `apt-get install` without version pins.
- `docker/qemu/Dockerfile` — same `apt-get` pattern.

Cargo and Go *module* dependencies are pinned via lockfiles
(`docker/Cargo.lock`, `docker/trusted_os/go.sum`). The image-build
step is the supply-chain weak point.

### L-5. The Trusted OS ELF is unsigned and not validated by QEMU

`qemu-system-arm -kernel` blindly loads whatever ELF you point at.
There's no equivalent of HABv4 in this path. Anyone who can write to
`bin/trusted_os.elf` can replace the firmware. Out of scope for a
hackathon kit; on real hardware (with HAB fuses), a parallel
mitigation exists.

### L-6. No rate limit on `__upload`

A malicious local tool could spam uploads, causing the supervisor to
churn through applet swaps. The supervisor doesn't accumulate state
between swaps, so the worst case is wasted CPU. Out of scope;
mitigation would be a token bucket in `bridge.go`.

## What was checked and found OK

- **`scripts/qemu.sh`, `scripts/make-sd-img.sh`** — `set -euo pipefail`,
  no string interpolation in privileged commands, no path-injection
  vector. The Docker port-publish is restricted to `127.0.0.1`.
- **`scripts/upload.ts`, `scripts/test-helpers.ts`,
  `examples/square/server.ts`** — all subprocess calls use `Bun.spawn`
  with array args (no shell interpolation). The one Bun shell template
  (`Bun.$\`cp examples/${name}/main.rs …\``) constrains `name` via a
  TS union type.
- **No secrets in the repo.** `.gitignore` covers `target/`, `bin/`,
  `*.elf`, `node_modules/`, `bun.lock`, `bun.lockb`. Hardcoded MAC and
  IP addresses (`1a:55:89:a2:69:41`, `10.0.0.1`) are link-local to the
  emulated NIC and identical across every QEMU instance.
- **Cargo + Go dependencies are pinned** in `docker/Cargo.lock` and
  `docker/trusted_os/go.sum`.

## Reporting issues

This is a hackathon starter — no formal security policy. If you find a
meaningful vulnerability that affects participants (e.g. a Trusted-OS
escape from a malformed applet, or a way to crash the QEMU guest from
the bridge), open an issue or pull request.
