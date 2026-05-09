# Builder image for the GoTEE Rust Starter Trusted OS.
#
# Contains: Go 1.24 bootstrap, TamaGo (built from source), u-boot-tools
# (mkimage), and arm-none-eabi-binutils (objcopy). The Rust applet is NOT
# built in here — Cargo runs on the host so the edit/upload/iterate loop
# stays fast.
#
# The host bind-mounts the repo at /work at run time; the recipe inside
# the container is just `make imx`.

# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM debian:bookworm-slim

ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
        git make wget ca-certificates build-essential \
        binutils-arm-none-eabi u-boot-tools && \
    rm -rf /var/lib/apt/lists/*

# Bootstrap Go — needed to compile TamaGo itself. TamaGo is a fork of the
# Go compiler that targets bare-metal ARM. We use go1.25.1 (TamaGo's
# `latest` branch as of 2026 requires bootstrap >= 1.24.6).
RUN case "$TARGETARCH" in \
        amd64) GO_ARCH=amd64 ;; \
        arm64) GO_ARCH=arm64 ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    wget -q "https://go.dev/dl/go1.25.1.linux-${GO_ARCH}.tar.gz" -O /tmp/go.tgz && \
    tar -C /usr/local -xzf /tmp/go.tgz && \
    rm /tmp/go.tgz

ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOROOT_BOOTSTRAP="/usr/local/go"

RUN git clone --depth 1 -b latest https://github.com/usbarmory/tamago-go /opt/tamago-go && \
    cd /opt/tamago-go/src && ./make.bash

ENV TAMAGO="/opt/tamago-go/bin/go"

WORKDIR /work
