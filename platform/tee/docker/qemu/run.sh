#!/bin/sh
# Auto-restart wrapper for qemu-system-arm.
#
# The Trusted OS calls os.Exit(0) when the bridge accepts an applet upload
# (mirroring the WDOG reset on real hardware — see reset.go and CLAUDE.md
# → "Hard-won lessons" → "__upload reply can race the reset"). QEMU exits
# with -no-reboot, this loop notices, sleeps a beat for the host TCP side
# to drain, and re-launches the emulator with the new applet loaded from
# bin/sd.img.
#
# Bind-mounts:
#   /work       <- repo root
#   /work/bin   <- trusted_os.elf + sd.img produced by `make qemu`

set -e

: "${TRUSTED_OS_ELF:=/work/bin/trusted_os.elf}"
: "${SD_IMG:=/work/bin/sd.img}"

if [ ! -f "$TRUSTED_OS_ELF" ]; then
    echo "error: $TRUSTED_OS_ELF missing — run 'make trusted_os' on the host first." >&2
    exit 1
fi
if [ ! -f "$SD_IMG" ]; then
    echo "error: $SD_IMG missing — run 'scripts/make-sd-img.sh' on the host first." >&2
    exit 1
fi

echo ">>> GoTEE Trusted OS — QEMU edition"
echo ">>> Trusted OS: $TRUSTED_OS_ELF"
echo ">>> SD image:   $SD_IMG"
echo ">>> Bridge:     0.0.0.0:4000  (published as 127.0.0.1:4000 on the host)"
echo ">>> SSH:        0.0.0.0:22    (published as 127.0.0.1:2222 on the host)"
echo

while true; do
    # mx6ullevk's UART1 is the console (mx6ullevk.go's Init calls
    # UART1.Init). On QEMU mcimx6ul-evk, serial_hd(0) is UART1, so the
    # first -serial maps the guest console to host stdout.
    qemu-system-arm \
        -machine mcimx6ul-evk -cpu cortex-a7 -m 512M \
        -nographic -monitor none -serial stdio -semihosting \
        -kernel "$TRUSTED_OS_ELF" \
        -nic "user,model=imx.enet,net=10.0.0.0/24,host=10.0.0.2,hostfwd=tcp:0.0.0.0:4000-10.0.0.1:4000,hostfwd=tcp:0.0.0.0:22-10.0.0.1:22" \
        -drive "if=sd,format=raw,file=$SD_IMG" \
        -no-reboot || true
    echo
    echo ">>> Trusted OS exited. Restarting in 1s..."
    sleep 1
done
