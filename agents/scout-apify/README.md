# Argus Apify scout

Off-chain intelligence agent. Polls a feed (Apify Actor results in
production, MockFeed in tests), mines each post for `(contract address,
threat keyword)` pairs, and posts signals to signal-api.

Default verdict is **UNCONFIRMED** because off-chain text is hearsay
until on-chain or source-code witnesses confirm it. The applet's
scoring rule won't escalate past YELLOW on a single UNCONFIRMED
signal — the scout's job is to *light a fuse* that other watchers
finish.

## Threat detection

Keyword-based, not parser-based. Three rule families today:

| Threat | Keywords (any) | Base reputation |
|---|---|---|
| **SWAT-001** | "arbitrary call", "approval drain", "transferFrom", "drain attack", "execute(", … | 70 |
| **SWAT-002** | "admin compromise", "ownership transferred", "private key leaked", … | 70 |
| **SWAT-005** | "rug pull", "rugpull", "liquidity removed", "exit scam" | 60 |

A `+10` urgency bonus applies if the post also mentions `exploit`,
`vulnerability`, `attacker`, `hack`, or `cve` (capped at 95).

The detector won't fire on stray address mentions: it only emits when
an address appears within ±120 chars of one of the rule keywords.
"GM, just deployed at 0xabc, no vulns" produces zero extractions.

## Wire format

Standard `signal-api` body. Notable evidence fields:

```json
{
  "source": "apify",
  "feed": "twitter:peckshield",
  "itemId": "peckshield/1",
  "author": "PeckShieldAlert",
  "url": "https://twitter.com/...",
  "keyword": "approval drain",
  "excerpt": "…we've identified an arbitrary call vulnerability in 0xabc…",
  "textSha256": "0x..."
}
```

`textSha256` is the deterministic evidence hash — re-runs over the
same post produce the same hash, so the applet's
`(addr, threatType, submitter)` dedupe still treats them as the same
signal.

## Apify + X402

The `ApifyFeed` accepts either a legacy Apify token (`apifyToken`) or
a per-request **X402 payment header** (`x402PaymentHeader`). When
Apify returns `402`, the body is the X402 challenge — mint the
payment header (ideally inside the TEE so the on-chain payment proof
is signed there) and retry. See
https://docs.apify.com/platform/integrations/x402.

This repo doesn't include an X402 minter; that lives in whichever
component is funding scout calls. For the hackathon you can run with
a regular Apify token and demonstrate the X402 path on the slides.

## Running

```bash
bun install
APIFY_TOKEN=... \
APIFY_ACTOR_ID=apify/twitter-scraper \
APIFY_RUN_INPUT='{"searchTerms":["DeFi exploit","SwapNet vulnerability"],"maxTweets":10}' \
SCOUT_CHAIN_ID=11155111 \
SCOUT_VERDICT=UNCONFIRMED \
  bun run start
```

Replace `APIFY_TOKEN` with `APIFY_X402_PAYMENT_HEADER` to use the
per-request payment path.

| Var | Default | Notes |
|---|---|---|
| `APIFY_ACTOR_ID` | required | e.g. `apify/twitter-scraper` |
| `APIFY_TOKEN` | one-of | legacy auth |
| `APIFY_X402_PAYMENT_HEADER` | one-of | X402 per-request payment |
| `APIFY_RUN_INPUT` | `{}` | JSON body POSTed to `run-sync-get-dataset-items` |
| `APIFY_TEXT_FIELD` / `_ID_FIELD` / `_AUTHOR_FIELD` / `_TS_FIELD` | `text` / `id` / `author` / `createdAt` | dataset-record field names |
| `ARGUS_API` | `http://127.0.0.1:8787` | signal-api base |
| `SCOUT_SUBMITTER` | `scout-apify.argus.eth` | submitter identity |
| `SCOUT_CHAIN_ID` | `1` | which chain the extracted addresses live on |
| `SCOUT_VERDICT` | `UNCONFIRMED` | `CONFIRMED` if you trust the source explicitly |
| `SCOUT_MAX_REPUTATION` | `75` | clamp on per-extraction reputation |
| `SCOUT_POLL_MS` | `60000` | poll cadence; 0 means run once and exit |

## Smoke

```bash
# Prereqs: signal-api on :8787, applet on :4000.
bun run smoke
```

Uses MockFeed loaded with three simulated tweets (two flag a known
address, one is benign). Verifies the extractor + scout submit
exactly the right signals, that dedup works on a second sweep, and
that signal-api state reflects the new SWAT-001 signal.
