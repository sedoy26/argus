#!/usr/bin/env bash
# Re-grant unlimited MockUSDC approval to FakeSwapNet for demo wallets on Sepolia.
# Does not touch signal-api; pair with scripts/reset-railway-demo.sh for a full demo loop.
#
# Required env:
#   SEPOLIA_RPC_URL      — HTTPS RPC URL
#   MOCK_USDC            — token contract (0x…)
#   FAKE_SWAP            — spender contract (0x…)
#   DEMO_PRIVATE_KEYS    — comma-separated private keys (0x… each)
#
# Optional:
#   CAST                 — path to cast (default: $HOME/.foundry/bin/cast)
set -euo pipefail

SEPOLIA_RPC_URL="${SEPOLIA_RPC_URL:?set SEPOLIA_RPC_URL}"
MOCK_USDC="${MOCK_USDC:?set MOCK_USDC}"
FAKE_SWAP="${FAKE_SWAP:?set FAKE_SWAP}"
DEMO_PRIVATE_KEYS="${DEMO_PRIVATE_KEYS:?set DEMO_PRIVATE_KEYS}"
MAX_UINT=115792089237316195423570985008687907853269984665640564039457584007913129639935

if [[ -n "${CAST:-}" ]]; then
  CMD=("$CAST")
elif command -v cast >/dev/null 2>&1; then
  CMD=(cast)
elif [[ -x "$HOME/.foundry/bin/cast" ]]; then
  CMD=("$HOME/.foundry/bin/cast")
else
  echo "error: foundry cast not found; install foundry or set CAST=" >&2
  exit 1
fi

i=1
IFS=',' read -r -a KEYS <<< "$DEMO_PRIVATE_KEYS"
for PK in "${KEYS[@]}"; do
  PK="${PK//[[:space:]]/}"
  [[ -z "$PK" ]] && continue
  ADDR=$("${CMD[@]}" wallet address --private-key "$PK" 2>/dev/null)
  echo "    wallet-$i $ADDR → approve MockUSDC for FakeSwap…"
  "${CMD[@]}" send "$MOCK_USDC" "approve(address,uint256)" "$FAKE_SWAP" "$MAX_UINT" \
    --private-key "$PK" \
    --rpc-url "$SEPOLIA_RPC_URL"
  i=$((i + 1))
done

echo "==> Sepolia approvals restored ($((i - 1)) wallets)."
