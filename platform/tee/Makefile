# Top-level delegator. The actual build recipes live in docker/Makefile
# (alongside the Rust/Go scaffolding) — this wrapper lets users run
# `make qemu` / `make applet` / `make clean` from the repo root.
#
# This branch is the QEMU-only edition. For the real USB Armory MK II
# variant (`.imx` build, SD flash, USB CDC-ECM link), see
# docs/PORTING_TO_USBARMORY.md.

.PHONY: applet trusted_os qemu clean

applet trusted_os qemu clean:
	@$(MAKE) --no-print-directory -C docker $@
