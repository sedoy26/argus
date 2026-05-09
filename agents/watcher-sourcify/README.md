# Argus Sourcify watcher

Pulls verified Solidity sources from [Sourcify](https://sourcify.dev)
for a configured set of contract addresses, runs the SWAT pattern
detector, and posts CONFIRMED signals to signal-api when a
vulnerability matches.

## What it detects today

| ID | Pattern | Implementation |
|---|---|---|
| **SWAT-001** | Approval abuse via arbitrary external call (`target.call(data)` where `target` and `data` are uncontrolled function params) | `src/detector.ts` |

The detector is regex-driven over comment-stripped source. Limitations
are documented in `src/detector.ts` — for a hackathon-scale demo this
is more than adequate; for production you'd want an AST pass with
solc-typed.

## Wire format

The watcher posts the standard signal-api payload:

```json
{
  "contractAddress": "0xabc...",
  "chainId": 11155111,
  "threatType": "SWAT-001",
  "verdict": "CONFIRMED",
  "evidence": {
    "source": "sourcify",
    "sourcify_status": "partial",
    "sourcify_url": "https://sourcify.dev/server/files/any/...",
    "file": "FakeSwapNet.sol",
    "function": "execute",
    "signature": "execute(address target, bytes calldata data)",
    "callKind": "call",
    "bodySnippet": "...",
    "accessControlled": false,
    "scannedFiles": ["FakeSwapNet.sol"]
  },
  "submitter": "watcher-sourcify.argus.eth",
  "reputation": 90
}
```

Reputation is reduced when `accessControlled` is true (signal still
ships, but with lower confidence) — the signal-api / applet weighing
then decides what to do with it.

## Running

```bash
bun install
WATCHER_TARGETS="11155111:0xabc...:fake-swap,1:0xdef...:foo" \
  bun run start
```

| Var | Default | Notes |
|---|---|---|
| `WATCHER_TARGETS` | required | comma-separated `<chainId>:<address>[:<label>]` |
| `ARGUS_API` | `http://127.0.0.1:8787` | signal-api base |
| `WATCHER_SUBMITTER` | `watcher-sourcify.argus.eth` | identity |
| `WATCHER_REPUTATION` | `90` | base reputation 0..100 |
| `WATCHER_POLL_MS` | `30000` | poll cadence; 0 means run once and exit |
| `SOURCIFY_BASE_URL` | `https://sourcify.dev/server` | for self-hosted mirrors |

## Smoke

The smoke uses an in-memory `FixedSourcify` fixture loaded with the
actual `FakeSwapNet.sol` from `contracts/`. It exercises:

1. Detector finds `SWAT-001` in FakeSwapNet.
2. Detector finds nothing in MockUSDC.
3. Watcher submits exactly one signal to signal-api for the vulnerable
   target.
4. A second sweep submits zero (dedup).
5. `/risk/:addr` reflects the new signal.

```bash
# Prereqs: signal-api on :8787, applet on :4000
bun run smoke
```
