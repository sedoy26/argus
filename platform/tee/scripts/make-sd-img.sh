#!/usr/bin/env bash
#
# Create the file-backed SD image consumed by QEMU's -drive if=sd.
#
# Idempotent: if bin/sd.img already exists with a non-zero size, leave it
# alone (so applet uploads persist across `make qemu` invocations). Only
# create + zero it if missing or empty. The first applet upload writes
# the user's ELF at LBA 65536; until then, the embedded default is the
# rescue path.

set -euo pipefail

cd "$(dirname "$0")/.."

SD_IMG="bin/sd.img"
SD_SIZE_MB=64

mkdir -p bin

if [[ -s "$SD_IMG" ]]; then
    exit 0
fi

echo "[+] Creating $SD_IMG (${SD_SIZE_MB} MB sparse)"
# Sparse: seek to (size-1) and write a single byte. Apparent size is
# SD_SIZE_MB MB, on-disk usage is ~0 until something writes.
dd if=/dev/zero of="$SD_IMG" bs=1 count=1 seek="$((SD_SIZE_MB * 1024 * 1024 - 1))" status=none
