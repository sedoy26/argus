# Argus Signal API

The Normal World HTTP host that fronts the Argus Trusted Applet. Watcher
agents and the dashboard talk to this service over HTTP; it translates
their requests into the applet's pipe-delimited bridge protocol and
returns the TEE-attested consensus envelope.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Bridge reachability ping |
| GET | `/boot` | Applet boot commitment + code hash |
| POST | `/signals` | Submit a verified signal |
| GET | `/risk/:address` | Query consensus for a contract |
| POST | `/demo/reset` | Hosted demo reset: clears events, score memory, social agents, enrollments; with `STANDALONE=1` also clears signals. **Auth:** JSON body `{ adminAddress, nonce, signature }` (admin wallet signs `buildAdminDemoResetMessage` in `enrollments.ts` — same text as dashboard) **or** header `x-argus-demo-reset` = `ARGUS_DEMO_RESET_SECRET` (optional env for curl/scripts). On-chain approvals: `scripts/reset-sepolia-approvals.sh`. |

### POST `/demo/reset` (Railway / CI)

**From the Argus dashboard (recommended):** Admin tab → **Reset hosted demo state** (wallet signature; no CLI).

**From curl** (optional shared secret on the server):

```bash
curl -sS -X POST "$ARGUS_SIGNAL_API/demo/reset" \
  -H "x-argus-demo-reset: $ARGUS_DEMO_RESET_SECRET" \
  -H "content-type: application/json" -d '{}'
```

Or: `scripts/reset-railway-demo.sh` when `ARGUS_DEMO_RESET_SECRET` is set.

In **bridge** mode the applet keeps its own signals — this only clears server-side feed + enrollment demo state; restart QEMU for a full TEE wipe.

### POST `/signals`

```json
{
  "contractAddress": "0xabc...",
  "chainId": 11155111,
  "threatType": "SWAT-001",
  "verdict": "CONFIRMED",
  "evidence": { "source": "sourcify", "finding": "arbitrary call" },
  "submitter": "watcher-sourcify.argus.eth",
  "reputation": 85
}
```

The server canonicalizes `evidence` (sorted-key JSON), SHA-256s it to
produce `evidence_hash`, then ships a `SUBMIT|...` line to the applet.
Response is `{ submitted: { evidence_hash, wire }, consensus: ... }`.

### GET `/risk/:address`

Returns the current consensus envelope for the given contract address.
Empty `score = "NONE"` if no signals have been submitted.

## Running

```bash
# Prerequisites: Bun (https://bun.sh) and a running QEMU emulator.
cd platform/tee && make qemu                       # Trusted OS in another shell
cd platform/signal-api
bun install
bun run dev                                        # http://localhost:8787

# Smoke test in a third shell:
bun run smoke
```

Defaults are 127.0.0.1:8787 (HTTP) and 127.0.0.1:4000 (bridge). Override
with `PORT`, `DEVICE_HOST`, `DEVICE_PORT`.

## Why `nc` instead of native sockets

The signal API shells out to `nc` per bridge call rather than using
`Bun.connect` or `node:net`. This matches the pattern in
`platform/tee/scripts/test-helpers.ts` — see its comment for the
hard-won reason: native TCP APIs wedge after the bridge link cycles on
a hot-swap reboot.

## Wire reference

The applet wire schema lives in
[`platform/tee/ARGUS-PROTOCOL.md`](../tee/ARGUS-PROTOCOL.md).
