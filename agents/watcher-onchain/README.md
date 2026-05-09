# Argus on-chain watcher

Subscribes to administrative events on monitored contracts and posts
SWAT signals to signal-api when the new owner / implementation looks
suspicious. Polling-based — works against any HTTP RPC.

## Detected events

| Event | Threat ID | Suspicion criteria |
|---|---|---|
| `OwnershipTransferred(prev, new)` | **SWAT-002** | new owner is a fresh EOA (balance 0, nonce 0) or low-activity (nonce < 3) |
| `Upgraded(impl)` | **SWAT-003** | implementation slot points at a non-contract address |

`OwnershipTransferred` from the zero address (constructor) and **to**
the zero address (renounce) are skipped — neither is a compromise.

## Wire format

Signals match the `watcher-sourcify` shape — see
`platform/tee/ARGUS-PROTOCOL.md`. Examples for SWAT-002:

```json
{
  "contractAddress": "0xabc...",
  "chainId": 31337,
  "threatType": "SWAT-002",
  "verdict": "CONFIRMED",
  "evidence": {
    "source": "on-chain",
    "event": "OwnershipTransferred",
    "previousOwner": "0xdeployer...",
    "newOwner": "0xfresh...",
    "block": "12",
    "txHash": "0x...",
    "adminProfile": { "balanceWei": "0", "txCount": 0, "isContract": false },
    "suspicion": "fresh EOA — zero balance, zero tx history"
  },
  "submitter": "watcher-onchain.argus.eth",
  "reputation": 80
}
```

## Running

```bash
bun install
WATCHER_TARGETS="11155111:0xabc...:fake-swap" \
RPC_URL="https://eth-sepolia.g.alchemy.com/v2/..." \
  bun run start
```

| Var | Default | Notes |
|---|---|---|
| `WATCHER_TARGETS` | required | comma-separated `<chainId>:<address>[:<label>]` |
| `RPC_URL` | `http://127.0.0.1:8545` | EVM HTTP RPC |
| `ARGUS_API` | `http://127.0.0.1:8787` | signal-api base |
| `WATCHER_SUBMITTER` | `watcher-onchain.argus.eth` | submitter identity |
| `WATCHER_MAX_REPUTATION` | `80` | clamp on heuristic-derived rep |
| `WATCHER_POLL_MS` | `5000` | poll cadence |

## Smoke

```bash
# Prereqs: signal-api on :8787, applet on :4000, forge build run.
bun run smoke
```

The smoke spins Anvil on :8546, deploys FakeSwapNet, generates a fresh
keypair, transfers ownership to it, runs `watcher.sweep()`, and
verifies the resulting signal-api state shows SWAT-002 in the consensus
summary. Second sweep is dedup-checked.
