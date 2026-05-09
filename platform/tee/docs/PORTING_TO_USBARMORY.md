# Porting this kit to a real USB Armory MK II

This branch (`pedro/qemu`) ships the GoTEE Rust Starter as a pure-software
QEMU image. The point of having a porting guide here is the team-of-three
scenario: one teammate has a real [USB Armory
MK II](https://github.com/usbarmory/usbarmory/wiki) on their desk, two
teammates don't. Both groups should be able to run the **same**
`src/main.rs` and the same `examples/`, talking to the same JSON bridge
on the same TCP port, with the same `bun run upload` flow.

This doc explains exactly what needs to change between the two
distributions. Everything user-visible (the applet code, the Rust crate
surface, the bridge protocol, the test harness) stays the same. The
divergence is concentrated in the Trusted OS, the build pipeline, and a
couple of host-side scripts.

The fastest way to get a working hardware build is to **start from this
branch's `main`** — `main` *is* the hardware distribution. This guide is
useful when you're re-applying the hardware bits on top of a QEMU
checkout, or when you're trying to understand what changed.

---

## What you need (hardware side)

- USB Armory MK II + a microSD card + a USB-C **data** cable.
- Docker (same as QEMU edition).
- Rust nightly + ARM bare-metal binutils (same).
- `u-boot-tools` for `mkimage` — only needed inside the builder
  container, so install requirement is in the Dockerfile, not the host.
- `nc` (BSD netcat) — same.
- Bun — same.
- `sudo` access on the host: macOS / Linux drop the host-side IP on the
  USB-CDC-ECM interface every time the device reboots, so the test
  runner re-arms it via `sudo ifconfig` / `sudo ip addr`.

---

## High-level diff between QEMU and hardware

| Concern              | QEMU (this branch)                                | Hardware (`main`)                                     |
|----------------------|---------------------------------------------------|--------------------------------------------------------|
| Boot path            | `qemu-system-arm -kernel bin/trusted_os.elf`      | i.MX6 BootROM → IVT → DCD → `bin/trusted_os.imx` from SD |
| Network transport    | FEC ENET + QEMU `-nic user` + `hostfwd`           | USB-CDC-ECM gadget over USB1                          |
| Bridge address       | `127.0.0.1:4000` (host) → `10.0.0.1:4000` (guest) | `10.0.0.1:4000` directly over the USB Ethernet link   |
| Reset on `__upload`  | In-process applet swap (no guest restart)         | Persist ELF to SD + `imx6ul.Reset()` (WDOG)           |
| Applet persistence   | RAM only — fresh `make qemu` boots the embedded default | SD card region at LBA 65536; survives power cycles |
| `RPC.LED`            | Logs to console                                   | Drives the actual blue LED                            |
| `RPC.Attest`         | Returns `Error="attestation unavailable under emulation"` | Returns hardware-derived DerivedKey (DCP/CAAM)        |
| Crypto init          | `imx6ul.Native` is false → BEE/CAAM/DCP skipped   | Native, BEE/CAAM/DCP set up in `init()`               |
| Host setup ceremony  | Docker only                                       | `sudo` for IP assignment, MAC-based `ifconfig` dance  |

The applet ABI, the Rust crate, and every example file are bit-identical
between the two.

---

## Step-by-step: re-add the hardware path on top of this branch

If you want both editions side by side on one branch, the cleanest
approach is **maintain them as separate branches** and merge `src/main.rs`
+ `examples/` changes between them. (This is what the team-of-three
hackathon flow assumes: applet authors PR to both branches, infra
authors don't.) But if you do want the hardware bits restored on a
single tree, here's the recipe.

### 1. Re-add the hardware-only scripts and config

These files exist on `main` and were removed when the QEMU branch was
created:

```bash
git checkout main -- scripts/flash-sd.sh
git checkout main -- scripts/armory-link.sh
git checkout main -- docker/imximage.cfg
git checkout main -- docker/build.sh
chmod +x scripts/flash-sd.sh scripts/armory-link.sh docker/build.sh
```

`docker/imximage.cfg` is the i.MX6 DCD blob — it brings up DDR3L pinmux
and the MMDC controller before the Trusted OS image is loaded into RAM.
Origin: <https://github.com/usbarmory/tamago/blob/master/board/usbarmory/mk2/imximage.cfg>
plus the trailing `DATA 4 0x020e4024 0x00000001 # TZASC_BYPASS` line
that GoTEE-example appends.

`scripts/flash-sd.sh` writes the `.imx` to byte 1024 of an SD card
(macOS rdiskN + Linux sdX/mmcblkN paths included).

`scripts/armory-link.sh` finds the host-side `enN` interface by MAC
(`1a:55:89:a2:69:42`, set in `docker/trusted_os/main.go` on `main`) and
assigns `10.0.0.2/24` to it.

### 2. Re-add the Trusted OS Go source for hardware

The QEMU branch deletes `docker/trusted_os/applet_store.go` and
`docker/trusted_os/reset.go`, and rewrites `main.go` to use FEC ENET +
in-process applet swap. To get the hardware versions back:

```bash
git checkout main -- docker/trusted_os/applet_store.go
git checkout main -- docker/trusted_os/reset.go
# main.go and bridge.go diverge structurally — review the diff:
git diff main..HEAD -- docker/trusted_os/main.go docker/trusted_os/bridge.go
```

Key changes you need to back out (or, equivalently, take from `main`):

- `main.go` imports `usbarmory "github.com/usbarmory/tamago/board/usbarmory/mk2"`
  and `usbnet "github.com/usbarmory/imx-usbnet"` instead of the
  mx6ullevk + go-net pair.
- `init()` runs the BEE/CAAM/DCP set-up unconditionally (`imx6ul.Native`
  is true on hardware) and includes the `usbarmory.DetectDebugAccessory`
  poll.
- `main()` reads the persisted applet from SD via `readAppletFromSD()`
  before falling back to the embedded default.
- `startNetworking()` configures `usbnet.Interface{}.Init(ip, mac,
  hostMAC)`, opens listeners via `iface.ListenerTCP4`, and runs
  `usbarmory.USB1.{Init,DeviceMode,Reset,Start}` to enumerate as
  USB-CDC-ECM.
- `bridge.go`'s `__upload` path calls `writeAppletToSD(elf)` and
  `triggerReset()` instead of pushing to `appletSwapCh`.
- `reset.go` calls `imx6ul.Reset()` (the WDOG software-reset wrapper).

### 3. Restore the `.imx` build steps

The QEMU branch's `docker/Makefile` removes the
`objcopy`/`mkimage`/IVT-fixup chain because `qemu-system-arm -kernel`
doesn't need it. The hardware path needs all of it back. Easiest:

```bash
git checkout main -- docker/Makefile Makefile docker/Dockerfile
```

That gets you `make imx`, `make trusted_os`, and the root delegator
back. The `BUILD_TAGS` change from `mx6ullevk,…` to `usbarmory,…`. The
mkimage step uses `imximage.cfg` (added in step 1) and the post-mkimage
`dd` fixup that copies the ELF's `e_entry` over the IVT entry field.

### 4. Restore the Go module deps

```bash
git checkout main -- docker/trusted_os/go.mod docker/trusted_os/go.sum
```

This swaps `usbarmory/go-net` back out for `usbarmory/imx-usbnet` and
re-adds the `usbarmory/tamago/board/usbarmory/mk2` import.

### 5. Restore host-side defaults

```bash
git checkout main -- scripts/upload.ts
git checkout main -- scripts/test-helpers.ts
git checkout main -- examples/attestation/attestation.test.ts
git checkout main -- package.json
```

`upload.ts` and `test-helpers.ts` default `DEVICE_HOST` back to
`10.0.0.1`. The attestation test asserts the `DerivedKey` shape
(non-empty, deterministic). `setupApplet` in `test-helpers.ts` regains
the `rearmLink()` step that runs `armory-link.sh` after every reboot.

### 6. Build, flash, run

```bash
./docker/build.sh                       # ~5 min first time, produces bin/trusted_os.imx
./scripts/flash-sd.sh /dev/diskN        # macOS: diskutil list  /  Linux: lsblk -o NAME,SIZE,RM
# Set the MK II boot switch to µSD, insert the card, plug into a host USB-C port.
./scripts/armory-link.sh                # assigns 10.0.0.2/24 to the host-side enN
printf '{"Method":"Echo","Input":"hi"}\n' | nc 10.0.0.1 4000
```

The hot-swap loop on hardware:

```bash
$EDITOR src/main.rs
make applet
bun run upload target/armv7a-none-eabi/release/trusted_applet
# device persists ELF to SD, triggers WDOG reset, comes back in ~5–8 s
./scripts/armory-link.sh                # macOS dropped enN's IP on the reboot
```

---

## Why some things cost extra effort on hardware

- **DCD is mandatory.** The Trusted OS ELF is ~11 MB after `objcopy -O
  binary`. The i.MX6ULL BootROM cannot fit anything that big in OCRAM
  (~128 KB), so the image must be loaded into DDR. DDR is uninitialized
  at boot — the DCD register-write sequence brings up the DDR3L
  controller. Without DCD, BootROM tries to write to dead memory and the
  device hangs silently.
- **TZASC_BYPASS in the DCD.** For Trusted-OS-class images, the upstream
  GoTEE-example Makefile appends `DATA 4 0x020e4024 0x00000001 #
  TZASC_BYPASS` so the Trusted OS can access DDR after init.
- **mkimage's `-e` flag is literal.** Go's linker places
  `_rt0_arm_tamago` somewhere inside `.text`, NOT at the symbolic
  `0x90010000` we pass to mkimage. The `dd if=$(OS_ELF) of=$(OS_IMX)
  bs=1 count=4 skip=24 seek=4 conv=notrunc` fixup copies the ELF's
  `e_entry` over the IVT entry field. Without it, BootROM jumps to
  `0x90010000` (mid-`.text`) and boot hangs silently.
- **`objcopy -j` list specificity.** Includes `.go.module` (Go runtime
  module info — without it, runtime startup hits a half-initialized
  module table and the boot just stops, no crash, no log). Excludes
  `.note.*` because those notes have VMAs *before* `.text` and would
  shift the binary layout by ~0xA0 bytes, making the IVT entry-point
  fixup land at the wrong place.
- **macOS routes 10.0.0.0/24 to the default gateway when no local
  interface owns it.** After a USB disconnect the host-side `enN` loses
  its IP. `ping 10.0.0.1` from the user's shell still gets a reply —
  but TTL is ~62 (going to whoever owns 10.0.0.1 upstream), not 64
  (direct USB). Always check TTL when "ping works but app fails."

QEMU avoids every one of these because `qemu-system-arm -kernel` skips
the BootROM/IVT/DCD path entirely and the network is just SLIRP.

---

## Why some things cost extra effort under QEMU

QEMU's `mcimx6ul-evk` machine model is mature but has gaps:

- **No DCP/CAAM/BEE crypto.** `RPC.Attest` returns the
  `imx6ul.Native==false` Error path. If your applet depends on
  hardware-derived keys, you can't test that on QEMU.
- **No GPIO LED panel.** `RPC.LED` is a logging stub.
- **USDHC software-reset bit doesn't auto-clear.** This breaks
  `usdhc.Detect()`, which is why the QEMU edition doesn't persist the
  applet to SD — we hot-swap in-process instead. Persistence across
  `make qemu` restarts requires rebuilding `bin/trusted_os.elf` to
  embed the new applet.
- **FEC PHY is a LAN911x stub** rather than the real Micrel KSZ8081RNB.
  This works fine for our test traffic but wouldn't be realistic for
  things like PHY auto-negotiation testing.

If you need any of those, the hardware path is your only option.

---

## Rough team workflow

1. Applet authors PR `src/main.rs` and `examples/<name>/main.rs` changes
   to both `main` and `pedro/qemu`. The diff is identical — only the
   surrounding plumbing differs by branch.
2. The QEMU teammates iterate fast: `make applet` + `bun run upload` +
   bridge probe, no flash, no `sudo`.
3. The hardware teammate validates against a real device every so often
   (especially anything that depends on `RPC.Attest` or `RPC.LED`).
4. CI can run `bun test` on the QEMU branch in any GitHub Actions
   runner with Docker. Hardware tests are run manually on the
   teammate's laptop.

---

## Canonical upstream sources

If you want to do the port from scratch instead of cherry-picking from
`main`, these are the references everything in `main` is based on:

- USB Armory MK II board package: <https://github.com/usbarmory/tamago/tree/master/board/usbarmory/mk2>
- DCD/imximage.cfg: <https://github.com/usbarmory/tamago/blob/master/board/usbarmory/mk2/imximage.cfg>
- GoTEE-example trusted_os: <https://github.com/usbarmory/GoTEE-example/tree/master/trusted_os_usbarmory>
- imx-usbnet (USB CDC-ECM gadget for TamaGo): <https://github.com/usbarmory/imx-usbnet>
- armory-boot (2nd-stage bootloader, source for the ELF loader we use): <https://github.com/usbarmory/armory-boot>
- imx_usb_loader (Serial Download recovery if you brick an SD): <https://github.com/boundarydevices/imx_usb_loader>
- USB Armory boot modes: <https://github.com/usbarmory/usbarmory/wiki/Boot-Modes-(Mk-II)>
