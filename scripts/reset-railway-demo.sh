#!/usr/bin/env bash
# Clear in-memory state on a hosted signal-api (Railway, etc.).
#
# Set:
#   ARGUS_SIGNAL_API  — base URL, e.g. https://argus-signal-api-production.up.railway.app
#   ARGUS_DEMO_RESET_SECRET — must match signal-api env (optional on server if you only use
#       Admin dashboard → "Reset hosted demo state" with a signed admin wallet)
#
# Optional: chain reset in same run (needs cast + env from reset-sepolia-approvals.sh):
#   RUN_SEPOLIA_APPROVALS=1 ./scripts/reset-railway-demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="${ARGUS_SIGNAL_API%/}"
SECRET="${ARGUS_DEMO_RESET_SECRET:?set ARGUS_DEMO_RESET_SECRET}"

echo "==> POST $API/demo/reset"
curl -sS -X POST "$API/demo/reset" \
  -H "x-argus-demo-reset: $SECRET" \
  -H "content-type: application/json" \
  -d '{}'
echo

if [[ "${RUN_SEPOLIA_APPROVALS:-}" == "1" ]]; then
  echo "==> Re-adding Sepolia approvals (RUN_SEPOLIA_APPROVALS=1)"
  bash "$ROOT/scripts/reset-sepolia-approvals.sh"
fi

echo "==> Done. Refresh the dashboard event feed."
