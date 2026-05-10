# Argus ENS CCIP-Read gateway

Off-chain side of EIP-3668 + ENSIP-10 wildcard resolution. The on-chain
`ArgusRiskResolver` reverts every `resolve()` with `OffchainLookup`
pointing at this server; clients forward the lookup here, we resolve it
against the signal-api, and the resolver passes our reply back as the
ENS record value.

```
client                          on-chain                          gateway
  │                                  │                                │
  │ resolve(name, text(node,"score"))│                                │
  │─────────────────────────────────►│                                │
  │     OffchainLookup revert        │                                │
  │◄─────────────────────────────────│                                │
  │                                                                   │
  │  GET /lookup/:sender/:data.json                                   │
  │──────────────────────────────────────────────────────────────────►│
  │                                                                   │ /risk/:addr
  │                                                                   ├───► signal-api ──► applet
  │                                                                   │
  │           {"data":"0x...abi(string)..."}                          │
  │◄──────────────────────────────────────────────────────────────────│
  │                                  │
  │  resolveCallback(response, ...)  │
  │─────────────────────────────────►│
  │       returns response           │
  │◄─────────────────────────────────│
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | liveness (no upstream); used for Railway healthchecks |
| GET | `/health` | gateway + signal-api status |
| GET | `/lookup/:sender/:data.json` | EIP-3668 GET form |
| POST | `/lookup` | EIP-3668 POST form, body `{sender, data}` |
| GET | `/preview/:addr` | non-CCIP debug view of every record for an address |

Default port: 8788. Override with `PORT`. Override the signal-api
base with `ARGUS_API` (default `http://127.0.0.1:8787`). Override the
frontend URL template (used for the `url` text record) with
`ARGUS_FRONTEND_URL_TEMPLATE` (default `https://argus.eth.limo/risk/{addr}`).

## Wildcard scheme

The on-chain resolver owns `risks.argus.eth` (or any name) wildcards:
querying `0xabc...risks.argus.eth` returns Argus risk records for the
contract at `0xabc...`. The gateway pulls that address out of the first
DNS label.

## Records served

Per [ENSIP-10](https://docs.ens.domains/ensip/10) text records, with
keys mapped onto the consensus envelope:

| Key | Value |
|---|---|
| `score` / `risk_score` | `NONE` / `YELLOW` / `ORANGE` / `RED` / `CRITICAL` |
| `confidence` | `0`–`100` as decimal string |
| `count` | total signals as decimal string |
| `confirmed` | distinct CONFIRMED submitters as decimal string |
| `summary` / `signals` | comma-separated `<threat>:<verdict>` |
| `attestation` | per-call SHA-256 attestation tag (0x-hex) |
| `code_hash` | applet code commitment (0x-hex) |
| `boot_commitment` | applet boot commitment (0x-hex) |
| `last_signal_ts` | last submission timestamp (unix seconds) |
| `updated` | ISO 8601 derived from `applet_ts_ns` |
| `url` / `argus_url` | frontend URL via `ARGUS_FRONTEND_URL_TEMPLATE` |
| `description` | one-line human-readable summary |

`addr()` (and `addr(node, 60)` for ETH) returns the contract address
embedded in the leading wildcard label — useful for clients that
auto-resolve names.

Anything else returns the empty value (`""` for text, zero address for
addr) per ENSIP-10 conventions.

## Running

```bash
bun install
bun run dev           # http://localhost:8788

# Validate end-to-end (signal-api + applet must already be up):
bun run smoke
```

The smoke script simulates the on-chain resolver's `OffchainLookup`
payload entirely in JS — no contract deploy required to verify the
gateway logic.

## Deploy notes

For Sepolia / mainnet you need the corresponding on-chain
`ArgusRiskResolver` contract pointed at this gateway's public URL. See
`contracts/` once that exists.

The gateway is stateless and idempotent — front it with whatever
caching / DNS / TLS layer fits. CCIP clients respect `cache-control`
headers from the gateway; we currently disable caching to keep risk
scores fresh.
