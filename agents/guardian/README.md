# Argus Guardian

Watches a contract address for risk-score escalation; when it crosses
the threshold, revokes every protected wallet's approval to that
address on every guarded token.

## Architecture

```
                    signal-api
                        │
                  GET /risk/:addr
                        │
                        ▼
                  ┌───────────┐         build approve(spender, 0)
   protected ───► │  Guardian │────────► sign  ───► sendRawTransaction
   wallets        │   loop    │                      to RPC
                  └───────────┘
                        │
                        ▼
                     Signer
                  ┌─────┴─────┐
            LocalSigner   KmsSigner
            (privKey)     (Orbitport)
```

The signer abstraction is the point: in development you can use
`LocalSigner` (a viem `privateKeyToAccount`); in production you wire
`KmsSigner` to SpaceComputer Orbitport KMS where the key is generated
inside the KMS, never seen by this process. Combined with on-chain
session-key scoping (ERC-4337) at the smart-wallet layer, the guardian
*physically cannot* sign anything outside its allowed set.

## Configuration

Environment variables (see `.env.example`):

| Var | Required | Notes |
|---|---|---|
| `RPC_URL` | yes | EVM RPC endpoint |
| `GUARDIAN_SPENDER` | yes | address to monitor + revoke approvals to |
| `GUARDIAN_TOKENS` | yes | comma-separated ERC-20 token addresses |
| `GUARDIAN_THRESHOLD` | no | default `CRITICAL`; one of NONE/YELLOW/ORANGE/RED/CRITICAL |
| `GUARDIAN_POLL_MS` | no | default `5000` |
| `ARGUS_API` | no | signal-api base URL (default `http://127.0.0.1:8787`); risk polling and optional `POST …/telemetry` use the same host |
| `ORBITPORT_CLIENT_ID` | path B (preferred) | + `ORBITPORT_CLIENT_SECRET` + `KMS_KEY_ID` → **`KmsSigner`**; revoke txs call `sdk.kms.sign` with `messageType: "DIGEST"` |
| `GUARDIAN_PRIVATE_KEY` | path A | `0x`-prefixed 32-byte hex → **`LocalSigner`** when KMS path is incomplete, or when `GUARDIAN_FORCE_LOCAL_SIGNER=1` forces local signing even if Orbitport is configured |
| `GUARDIAN_FORCE_LOCAL_SIGNER` | no | Set to `1` to use `GUARDIAN_PRIVATE_KEY` for the primary signer while still having Orbitport vars in `.env` (e.g. Anvil smoke + creds present) |
| `ARGUS_TELEMETRY_SECRET` | no | Shared secret; must match signal-api `ARGUS_TELEMETRY_SECRET` so `POST /telemetry` accepts guardian lines. With KMS, the feed shows a **startup** “Guardian signed via Space KMS ✓ — KMS signer online…” line plus each **revoke** line from `notifyGuardianRevoke`. |

If neither signer path is fully configured the guardian errors at
startup.

### One-shot KMS demo (judges / Space track)

With Orbitport credentials (and `ARGUS_TELEMETRY_SECRET` matching signal-api):

```bash
bun run kms-demo
```

This runs **`kms.CreateKey`** when `KMS_KEY_ID` is unset (otherwise reuses your key), builds a **revoke-shaped** `approve(spender, 0)` EIP-1559 transaction, signs it via **`KmsSigner` → `kms.sign(DIGEST)`**, and **`POST`s `/telemetry`** so the dashboard shows the Space KMS badge. By default the signed tx is **not** broadcast (`KMS_DEMO_BROADCAST=1` to submit on-chain; fund the KMS address first).

## Running

```bash
bun install
cp .env.example .env
# fill in .env, then:
bun run start
```

## Smoke test (local Anvil, no KMS, no testnet)

The smoke spins a fresh Anvil, deploys MockUSDC + FakeSwapNet from
`contracts/out/`, approves max, escalates the spender to CRITICAL via
signal-api, runs `guardian.revokeAll()`, and confirms the attacker can
no longer drain via FakeSwapNet's arbitrary-call vulnerability.

Prereqs:

1. `forge build` in `contracts/`
2. signal-api up on :8787
3. applet up on :4000 (`make qemu` in `platform/tee/`)

```bash
bun run smoke
```

## KMS path (when you have credentials)

1. Register at https://accounts.spacecomputer.io for client ID/secret.
2. Create an ETHEREUM-scheme key once (`bun run kms-create-key` from repo `scripts/`, or `bun run kms-demo` which calls **`kms.CreateKey`** when `KMS_KEY_ID` is unset) and fund the returned address on **Sepolia** (or your target chain).
3. Set `ORBITPORT_CLIENT_ID` / `ORBITPORT_CLIENT_SECRET` / `KMS_KEY_ID`
   (and optionally `KMS_KEY_ADDRESS` to skip the recovery probe).
4. Remove `GUARDIAN_FORCE_LOCAL_SIGNER` (or do not set `GUARDIAN_PRIVATE_KEY` as the primary path you want) so the **KMS path wins** over local demo keys.
5. `bun run start`.

The guardian signs each revoke with `kms.sign({ messageType:
"DIGEST", signingAlgorithm: "ETHEREUM_SECP256K1" })` against the
keccak-256 digest of the unsigned EIP-1559 transaction (`KmsSigner` in `src/signer.ts`).
