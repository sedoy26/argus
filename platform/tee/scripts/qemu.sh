#!/usr/bin/env bash
#
# Launch the QEMU runtime container. Called from `make qemu` after the
# Trusted OS ELF and SD image have been produced on the host.
#
# The container runs an auto-restart wrapper around qemu-system-arm
# (docker/qemu/run.sh). The bridge port (4000) and SSH port (2222) are
# published on 127.0.0.1 only — no LAN exposure.
#
# Ctrl-C tears down the container cleanly.

set -euo pipefail

cd "$(dirname "$0")/.."

QEMU_IMAGE=gotee-qemu
TRUSTED_OS_ELF="bin/trusted_os.elf"
SD_IMG="bin/sd.img"

if [[ ! -f "$TRUSTED_OS_ELF" ]]; then
    echo "error: $TRUSTED_OS_ELF missing — run 'make trusted_os' first." >&2
    exit 1
fi
if [[ ! -f "$SD_IMG" ]]; then
    echo "error: $SD_IMG missing — run 'scripts/make-sd-img.sh' first." >&2
    exit 1
fi

# Interactive flags only make sense if stdin is a TTY. CI / pipelines /
# `make qemu &` don't have one — fall back to `-t` only so Docker still
# allocates a pseudo-terminal for the wrapper output without trying to
# wire stdin to a tty that doesn't exist.
TTY_FLAGS="-t"
if [ -t 0 ]; then
    TTY_FLAGS="-it"
fi

# `--init` reaps the QEMU process so Ctrl-C exits cleanly even when the
# wrapper script is mid-restart.
exec docker run --rm --init $TTY_FLAGS \
    -p 127.0.0.1:4000:4000 \
    -p 127.0.0.1:2222:22 \
    -v "$PWD":/work \
    "$QEMU_IMAGE"
