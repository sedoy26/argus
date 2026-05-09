# Argus applet wire protocol

The Argus consensus engine lives in `src/main.rs` as a Trusted Applet
running under the GoTEE Trusted OS. Callers reach it through the
GoTEE bridge on `127.0.0.1:4000` (newline-delimited JSON, see
`platform/tee/CLAUDE.md` → "Bridge protocol").

The bridge envelope is unchanged:

```
→ {"Method":"<name>","Input":"<utf-8>"}\n
← {"Output":"<utf-8>"}\n
```

The applet defines three methods inside that envelope.

## Methods

### `BootInfo`

Diagnostic. Returns the per-boot commitment, the code hash, and current
counts. Not state-mutating.

Input: empty string.

Output (JSON):

```json
{
  "boot_commitment":  "0x<sha256(\"argus-boot-v1\\0\" || BOOT_SECRET)>",
  "code_hash":        "0x<sha256(CODE_HASH_INPUT)>",
  "code_hash_input":  "argus-applet-v0.1-dev",
  "boot_ts_ns":       1234567890000000,
  "now_ns":           1234567899900000,
  "signal_count":     7,
  "max_signals":      256
}
```

### `Signal`

Submit a verified threat signal for a contract. The applet stores it,
recomputes consensus for the contract, and returns the new envelope.

Input format — a single pipe-delimited line:

```
SUBMIT|<addr>|<chain_id>|<threat_type>|<verdict>|<evidence_hash>|<submitter>|<rep>|<ts>
```

| Field | Type | Notes |
|---|---|---|
| `addr` | `0x` + 40 hex chars | EVM address, lowercase preferred |
| `chain_id` | u32 | 1, 11155111 (Sepolia), etc. |
| `threat_type` | ASCII ≤16 chars | e.g. `SWAT-001` |
| `verdict` | enum | `CONFIRMED`, `UNCONFIRMED`, or `DISPUTED` |
| `evidence_hash` | `0x` + 64 hex chars | sha256 of raw evidence (Sourcify response, tweet, etc.) |
| `submitter` | ASCII ≤64 chars | watcher identifier (ENS name or wallet address recommended) |
| `rep` | u8 | submitter reputation 0–100 |
| `ts` | u64 | unix seconds when the signal was observed |

Dedupe key inside the applet is `(addr, threat_type, submitter)` —
re-submission updates the prior entry rather than counting twice. This
is what makes "confirmed_count = 2" mean *two distinct submitters
agree*, not "the same submitter sent twice".

Output (JSON): see [Consensus envelope](#consensus-envelope) below.

### `Query`

Read current consensus for a contract without submitting anything.

Input: `QUERY|<addr>` or just `<addr>`.

Output: same [Consensus envelope](#consensus-envelope) — `count = 0` and
`score = "NONE"` if the address is unknown.

## Consensus envelope

Output schema for both `Signal` and `Query`:

```json
{
  "score":           "NONE | YELLOW | ORANGE | RED | CRITICAL",
  "confidence":      0,
  "count":           0,
  "confirmed":       0,
  "addr":            "0x<20-byte hex>",
  "summary":         "SWAT-001:CONFIRMED,SWAT-002:UNCONFIRMED",
  "last_signal_ts":  0,
  "applet_ts_ns":    0,
  "code_hash":       "0x<32-byte hex>",
  "boot_commitment": "0x<32-byte hex>",
  "attestation":     "0x<32-byte hex>"
}
```

### Scoring rule

```
confirmed = number of distinct submitters with verdict=CONFIRMED for this addr

CRITICAL  if confirmed >= 3
RED       if confirmed >= 2
ORANGE    if confirmed >= 1
YELLOW    if any signal exists for this addr
NONE      otherwise
```

`confidence` = sum of reputations of distinct CONFIRMED submitters,
clamped to `[0, 100]`.

### Attestation tag

```
attestation = sha256(
  "argus-attest-v1"
  || BOOT_SECRET                           (32 B, generated once at applet boot)
  || score_label                           ("CRITICAL" | "RED" | …)
  || addr                                  (20 B)
  || count                                 (u32 BE)
  || confirmed                             (u32 BE)
  || confidence                            (u8)
  || last_signal_ts                        (u64 BE)
  || applet_ts_ns                          (u64 BE)
  || CODE_HASH                             (32 B)
)
```

A verifier who recorded `BOOT_COMMITMENT` from the applet's startup log
trusts that an attestation tag could only have been produced by code
that knows `BOOT_SECRET` — i.e. the running applet. They cannot recompute
the tag without `BOOT_SECRET`, but they don't need to: if a different
attestation appears claiming the same `BOOT_COMMITMENT`, the verifier
knows it is forged.

This is a deliberate simplification for the QEMU demo. On real USB
Armory hardware the boot secret is replaced with a key derived from
`RPC.Attest`, and the tag is an Ed25519 signature over the same
canonical fields. See `docs/PORTING_TO_USBARMORY.md`.

## Examples

```bash
# Boot info
printf '{"Method":"BootInfo","Input":""}\n' | nc -w 5 127.0.0.1 4000

# Submit one signal
printf '{"Method":"Signal","Input":"SUBMIT|0x1234567890123456789012345678901234567890|11155111|SWAT-001|CONFIRMED|0xa9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0|watcher-sourcify.argus.eth|85|1746745001"}\n' \
  | nc -w 5 127.0.0.1 4000

# Query the same contract
printf '{"Method":"Query","Input":"0x1234567890123456789012345678901234567890"}\n' \
  | nc -w 5 127.0.0.1 4000
```

## Constraints (so callers don't surprise themselves)

- Single-line `Input` only; the bridge is newline-delimited.
- Total input size after JSON envelope ≤ 4 KB. With our pipe schema you
  fit ~30 signals before bumping into that.
- Output ≤ 1 KB per call. With 8 sample summaries and 32-byte hashes
  we typically land at ~600 B.
- Concurrency: the GoTEE bridge serializes calls to the applet. Don't
  expect parallelism from the applet's side.
- Storage: 256 signals total, in RAM only. Lost on QEMU restart.
