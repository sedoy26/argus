# Runtime container for the QEMU emulator.
#
# Tiny on purpose: just qemu-system-arm and a wrapper script. The Trusted
# OS ELF and the SD image are bind-mounted from the host at runtime
# (built by `make trusted_os` and `scripts/make-sd-img.sh` respectively).
#
# Multi-arch: works on amd64 and arm64 hosts. We're emulating ARM-A7
# (32-bit) so KVM acceleration is unavailable cross-arch; plain TCG runs
# at acceptable speed for a hackathon kit.

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        qemu-system-arm && \
    rm -rf /var/lib/apt/lists/*

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]
