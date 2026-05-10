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
  "submitter": "watcher-sourcify.agents.argus-security.eth",
  "reputation": 90
}
```

Reputation is reduced when `accessControlled` is true (signal still
ships, but with lower confidence) — the signal-api / applet weighing
then decides what to do with it.

## Running

```bash
bun install
# Defaults: Sepolia FakeSwapNet demo + local .sol fallback if Sourcify has no entry
bun run start
```

With explicit targets (and optional extra contracts):

```bash
WATCHER_TARGETS="11155111:0xabc...:fake-swap,11155111:0xdef...:foo" bun run start
```

| Var | Default | Notes |
|---|---|---|
| `WATCHER_TARGETS` | Sepolia `FAKE_SWAPNET_ADDRESS` (see below) | comma-separated `<chainId>:<address>[:<label>]` |
| `ARGUS_API` | `http://127.0.0.1:8788` | signal-api base (same port as `reset.sh`). **If set, overrides ENS `signal_api`** (so an old Cloudflare tunnel in ENS does not break local demos). |
| `FAKE_SWAPNET_ADDRESS` | dashboard/guardian demo spender | used for default target + local fallback address |
| `WATCHER_SUBMITTER` | `watcher-sourcify.agents.<ARGUS_ENS_ROOT>` | identity on the signal |
| `WATCHER_REPUTATION` | `85` | base reputation 0..100 |
| `WATCHER_POLL_MS` | `60000` | poll cadence; `0` runs one sweep then idles (process stays up) |
| `WATCHER_LOCAL_FALLBACK` | `1` | if `0`, only on-chain Sourcify verified sources are used |
| `WATCHER_LOCAL_SOL_PATH` | repo `contracts/src/FakeSwapNet.sol` | path for fallback when Sourcify returns 404 |
| `SOURCIFY_BASE_URL` | `https://sourcify.dev/server` | for self-hosted mirrors |

### Local source fallback

The Sepolia demo contract address is often **not** the same byte-for-byte artifact published on sourcify.dev (or it is not verified under that address). When Sourcify returns no files, the watcher loads `contracts/src/FakeSwapNet.sol` from this repo, runs the same SWAT-001 detector, and submits a real `POST /signals` with `evidence.source = sourcify+local` and `source_url = file://…`. For contracts that **are** verified on Sourcify, the HTTP path is used and no fallback is needed.

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
# Prereqs: signal-api (default ARGUS_API http://127.0.0.1:8788), applet on :4000
bun run smoke
```
