#!/usr/bin/env bash
# Argus development environment.
#
# Source this file (don't execute it) to put the ARM toolchain, Rust,
# and Bun on PATH for the current shell:
#
#   source scripts/devenv.sh
#
# It's a no-op if the tools are already reachable.

ARGUS_ARM_HOME="${ARGUS_ARM_HOME:-$HOME/.local/argus-toolchain/arm-gnu-toolchain-15.2.rel1-darwin-arm64-arm-none-eabi}"

if [ -d "$ARGUS_ARM_HOME/bin" ] && ! command -v arm-none-eabi-ld >/dev/null 2>&1; then
  export PATH="$ARGUS_ARM_HOME/bin:$PATH"
  echo "[devenv] arm-none-eabi toolchain → $ARGUS_ARM_HOME/bin"
fi

if [ -f "$HOME/.cargo/env" ] && ! command -v cargo >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
  echo "[devenv] cargo → $HOME/.cargo/bin"
fi

if [ -d "$HOME/.bun/bin" ] && ! command -v bun >/dev/null 2>&1; then
  export PATH="$HOME/.bun/bin:$PATH"
  echo "[devenv] bun → $HOME/.bun/bin"
fi

if [ -d "$HOME/.foundry/bin" ] && ! command -v forge >/dev/null 2>&1; then
  export PATH="$HOME/.foundry/bin:$PATH"
  echo "[devenv] foundry → $HOME/.foundry/bin"
fi

# Sanity report.
for cmd in docker arm-none-eabi-ld cargo rustup bun forge cast nc make; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf "[devenv] %-20s %s\n" "$cmd" "$(command -v $cmd)"
  else
    printf "[devenv] %-20s MISSING\n" "$cmd"
  fi
done
