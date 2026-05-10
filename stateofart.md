# Argus — state of the art

This document captures **where the project stands today**, **what is implemented and verified**, **how demos are run**, and **what would naturally come next**. It complements the pitch-level [`README.md`](./README.md) and the long-form [`architecture-vision.md`](./architecture-vision.md).

---

## 1. What Argus is (current framing)

Argus is a **security intelligence and demo stack** for Ethereum that combines:

1. **Consensus over “signals”** — multiple submitters report threat-shaped findings for contract addresses; the system aggregates them into a **score** (NONE → CRITICAL) and an **envelope** (score, counts, attestation-shaped fields, etc.).
2. **A normal-world HTTP API** (`platform/signal-api`) — watchers, scouts, and the dashboard submit signals and query risk.
3. **Optional TEE-backed consensus** — when the GoTEE bridge and QEMU appliance are running locally, the Rust **Trusted Applet** in `platform/tee` computes consensus and returns **real** boot / attestation metadata over TCP (`DEVICE_HOST` / `DEVICE_PORT`, default `127.0.0.1:4000`).
4. **Standalone consensus** — when `STANDALONE=1`, the same HTTP API runs **in-process** consensus (mirroring applet rules) with **placeholder** boot hash and **deterministic mock** attestation fields. This mode is used for **cloud deploys** (e.g. Railway) where QEMU is not attached.
5. **ENS CCIP-Read gateway** (`platform/ens-resolver`) — resolves wildcard-style queries by calling signal-api and mapping envelope fields to ENS text records; includes a human **`/preview/:addr`** JSON view.
6. **Dashboard** (`dashboard/`) — React + Vite + Tailwind 4: **EIP-6963** wallet discovery (with legacy fallback), **role-gated** Scout / User / Admin experiences, intel submission, **social profile agents**, live event feed, contract cards, and a **glass / motion** UI with the Argus brand mark.
7. **Agents** (repo `agents/*`) — separate processes: Sourcify-oriented watcher, Apify-oriented scout, on-chain watcher, guardian (KMS-oriented); they speak to signal-api over HTTP.

**Important distinction:** “Production hardening” in the sense of multi-tenant persistence, signed gateway responses, and KMS-only guardians is **not** fully realized; the repo is **hackathon-grade** with clear extension points.

---

## 2. Runtime topology (how pieces connect)

### 2.1 Local development (full trust story)

| Piece | Role | Typical command / port |
|--------|------|-------------------------|
| QEMU + GoTEE | Trusted applet + bridge | `platform/tee` — `make qemu`, bridge **:4000** |
| signal-api | HTTP → bridge or standalone | `bun run dev` — **:8787** (or shifted in `reset.sh` demos) |
| ens-resolver | CCIP gateway → signal-api | `bun run dev` — **:8788** |
| dashboard | UI via Vite proxy `/api`, `/gw` | `bun run dev` — **:5173** |
| agents | Background workers | Per-package README / env |

**`scripts/demo.ts`** (and related demo scripts) document an **end-to-end narrative**: Anvil, contracts, approvals, staged signals, guardian revoke story — **expecting** local QEMU + signal-api (see script header comments).

### 2.2 Cloud (Railway) — current practical layout

Three services are set up for **public demo** behavior:

| Service | Behavior |
|---------|-----------|
| **signal-api** | `STANDALONE=1` — **no** bridge; `/health` reports `bridge: n/a`. |
| **argus-gateway** (ens-resolver) | `ARGUS_API` points at the **hosted** signal-api URL. |
| **argus-dashboard** | Static build + `serve`; **`VITE_SIGNAL_API`** / **`VITE_GATEWAY_URL`** baked at build time. |

**Hybrid (hosted UI + local TEE):** Browsers block HTTPS pages from calling `http://localhost` (mixed content). The dashboard README documents **HTTPS tunnels** (e.g. Cloudflare) and optional **`localStorage`** overrides (`ARGUS_SIGNAL_API_OVERRIDE`, `ARGUS_GATEWAY_URL_OVERRIDE`) so a public UI can target a tunneled local API.

---

## 3. Implemented surface (by area)

### 3.1 `platform/signal-api` (Bun)

**Core**

- `GET /health` — standalone vs bridge ping semantics.
- `GET /boot` — applet boot info **or** standalone placeholder payload.
- `POST /signals` — validated submissions → TEE wire **or** standalone store.
- `GET /risk/:address` — consensus envelope for an address (normalized path; trailing slash stripped on router).
- `GET /events` — in-memory event stream for the dashboard feed.
- `POST /intel` — URL/text → corroboration pipeline shared with agents (Apify-related behavior and fallbacks where configured).
- `POST /simulate-tx` — demo / SWAT-004 style path (used with Sourcify + TEE narrative in UI).

**Access & enrollment (in-memory)**

- `GET /access?address=…` — privileged / admin flags, approved roles, pending enrollment, `authStrict`, and **`queriedAddress`** (normalized echo of the query param so the UI can detect stripped proxies). Response uses **`Cache-Control: no-store`** so CDNs/browsers do not reuse another wallet’s JSON.
- `GET /auth/nonce` — scoped nonces for signing flows.
- `POST /enrollment` — signed contributor request.
- `POST /enrollment/moderate` — admin signed approve/reject/list.

**Social agents (in-memory)**

- `GET|POST|DELETE /agents/social` — list, create, stop profile-driven pollers (Reddit JSON + Twitter via Apify when `APIFY_TOKEN` is set).
- Legacy paths **`/agents/reddit`** — same handlers for compatibility.

**Cross-cutting**

- **CORS** enabled broadly (`*`) for browser dashboard; **DELETE** allowed for agent cleanup.
- Optional **SpaceComputer Orbitport** cTRNG for nonce material when credentials exist (otherwise CSPRNG fallback).

**Limits**

- Enrollments, events, and social agents are **ephemeral** (RAM). Restart or multi-replica deploy loses state unless external storage is added.

### 3.2 `platform/ens-resolver` (Bun)

- EIP-3668-style **`/lookup/...`** and **`POST /lookup`**.
- **`GET /preview/:addr`** for debugging / UI.
- **`GET /health`** — includes upstream signal-api reachability.
- **CORS** on JSON responses + **OPTIONS** for cross-origin dashboard calls to `/preview`.

### 3.3 `platform/tee` (GoTEE + Rust applet)

- QEMU-based dev path; applet implements consensus and attestation semantics consumed by signal-api in **bridge** mode.
- Not run on Railway; see `platform/tee/README.md` and `ARGUS-PROTOCOL.md` for protocol details.

### 3.4 `dashboard/` (React + Vite)

**UX**

- Landing → **Connect wallet**: EIP-6963 announcements drive the picker when available (avoids duplicate “MetaMask” rows that were really Rainbow / multiplexer duplicates). Legacy `window.ethereum.providers` is used only if nothing announces in time.
- **Role tabs:** Scout (privileged allowlist or approved scout enrollment), User, Admin (**only** `ARGUS_ADMIN_ADDRESSES` — not inferred from the scout list).
- **Scout:** Intel panel (tweet URL / free text), **social agents** panel, watchlist, live **event feed**, contract **cards**, **detail** panel (envelope + gateway preview records).
- **User:** Demo “wallet protection” narrative around the **Sepolia FakeSwapNet** demo address, bundles / social add-on toggle, contributor enrollment card, simplified alerts.
- **Admin:** Enrollment moderation queue (signed list / approve / reject).

**Engineering**

- Dev **Vite proxy** (`/api`, `/gw`) with overrides via `VITE_API_TARGET` / `VITE_GW_TARGET` or repo `scripts/.env` keys `ARGUS_API` / `ARGUS_GATEWAY`.
- Production **`signalUrl` / `gatewayUrl`** via `VITE_SIGNAL_API` / `VITE_GATEWAY_URL` + optional **localStorage** overrides.
- **Glassmorphism** UI (`glass-surface`, aurora backdrop, parallax brand logo on landing, larger header mark).
- **`/access` client:** strict boolean parsing for flags, `fetch(..., { cache: 'no-store' })`, verification that **`queriedAddress`** matches the connected wallet when the API provides it, and a **generation guard** so an in-flight `/access` for a previous account cannot overwrite access after a wallet switch.
- Error boundary (see `main.tsx` in repo history) and defensive wallet `accountsChanged` handling where providers are brittle.

### 3.5 `contracts/` (Foundry)

Present in-tree (non-exhaustive):

- **`FakeSwapNet.sol`**, **`MockUSDC.sol`** — vulnerable / clean demo targets for Sourcify-style analysis.
- **`ArgusRiskResolver.sol`** — ENS wildcard + CCIP-Read resolver pattern.
- **`ArgusRegistry.sol`** — agent registry used by the dashboard’s Sepolia client (address in dashboard source).

Deploy / seed scripts exist under `contracts/script/` (e.g. `Deploy.s.sol`, `SeedAgents.s.sol`). Root README still mentions **RecoveryVault** as part of the vision; that contract is **not** currently under `contracts/src/` as a file — treat as **roadmap** unless added.

### 3.6 `agents/`

| Agent | Purpose |
|-------|---------|
| **watcher-sourcify** | Static analysis + Sourcify (or local fallback) → `POST /signals`. Includes **smoke** script. |
| **scout-apify** | Tweet / feed extraction → scout pipeline → signal-api. **MockFeed smoke** avoids live Apify in CI. |
| **watcher-onchain** | On-chain activity → signals (per README). |
| **guardian** | Consumes high-risk consensus / events, performs protective txs with configured keys (per README). |

Each is **optional** for “UI only” demos but required for **full story** demos.

### 3.7 `scripts/`

- **`demo.ts`** — flagship scripted demo (Anvil + staged signals + narrative); expects local infra.
- **`demo-sepolia.ts`** — Sepolia-oriented helper (see file for scope).
- **ENS / setup helpers** — e.g. registration scripts referencing gateway URLs.

---

## 4. Demo cases — what is tested / known to work

Legend: **Automated** = repo smoke/unit script exists. **Manual** = validated in dev sessions / described in READMEs but not necessarily CI-gated.

### 4.1 Automated smokes (high signal)

| Area | Command / location | What it proves |
|------|-------------------|----------------|
| signal-api | `platform/signal-api` — `bun run smoke` | HTTP `/health`, `/boot`, `/signals`, `/risk` against a running API + bridge expectations (see script header). |
| watcher-sourcify | `agents/watcher-sourcify` — `bun run smoke` | Detector finds **SWAT-001** in FakeSwapNet, clean on MockUSDC, watcher submits once, dedup on second sweep, `/risk` reflects signal. |
| scout-apify | `agents/scout-apify` — `bun run smoke` | Extractor + `Scout.runOnce` with **MockFeed**, dedup, `/risk` shows scout contribution. |
| ens-resolver | `platform/ens-resolver/scripts/smoke.ts` | Gateway behavior against a reachable signal-api (per script). |

### 4.2 Integrated local demos (manual or semi-automated)

| Scenario | Status | Notes |
|----------|--------|--------|
| **Vite dashboard + local signal + local gateway** | **Works** when proxy targets match running ports (`dev:reset` / `scripts/.env`). | Most common dev loop for UI + API. |
| **Dashboard → `/intel` → score / events** | **Works** in dev with signal-api up; Apify pieces depend on **`APIFY_TOKEN`** and rate limits. | Scout tab + social add-on gating per access policy. |
| **Social agents (Reddit)** | **Works** for public JSON endpoints without keys. | Polling is server-side; state is in-memory. |
| **Social agents (X/Twitter)** | **Works when `APIFY_TOKEN`** is configured on signal-api. | Otherwise expect errors or reduced behavior. |
| **`scripts/demo.ts` full chain** | **Works when prerequisites running** (QEMU, signal-api, paths in script). | Heavy; best pre-stage / recorded backup (see `presentation/`). |
| **Railway standalone stack** | **Deployed pattern** | signal-api + gateway + static dashboard; **no** TEE attestation equivalence to QEMU mode. Set **`ARGUS_ADMIN_ADDRESSES`** on signal-api for the wallet(s) that may use Admin / demo reset; **`ARGUS_PRIVILEGED_ADDRESSES`** is for Scout bypass only (comma-separated `0x…40`). |

### 4.3 UI / product demos (manual checklist)

- **Landing glass + parallax logo** → connect wallet.
- **Privileged wallet** → Scout + intel + social agents + watchlist + live feed + detail pane.
- **Judge-style wallet** → User tab simplified story + enrollment request if `ARGUS_AUTH_STRICT` path enabled.
- **Admin wallet** → moderation queue operations (signing flows).
- **ENS preview** in dashboard → requires gateway reachable and `VITE_GATEWAY_URL` (prod) or `/gw` proxy (dev).

---

## 5. Gaps, risks, and “would be nice”

### 5.1 Trust & security (intentional demo debt)

| Topic | Current state | Nice next step |
|-------|---------------|----------------|
| Gateway authenticity | CCIP URLs trusted by resolver config; README notes **no Ed25519 gateway signature** in Solidity callback. | Sign gateway responses; verify on-chain. |
| Standalone attestation | Deterministic placeholder hash / “fingerprint”. | Only advertise as demo; or tie to real remote attestation service. |
| CORS | Permissive `*` on API / gateway. | Restrict to known dashboard origins in production. |
| Auth | Server-side allowlists + signed messages; **admin** and **scout bypass** are separate env vars (`ARGUS_ADMIN_ADDRESSES` vs `ARGUS_PRIVILEGED_ADDRESSES`); dashboard hardens `/access` races and caching. | Tie enrollments to on-chain roles or SIWE session; tighten CORS to dashboard origins. |

### 5.2 Persistence & ops

| Topic | Current state | Nice next step |
|-------|---------------|----------------|
| Enrollments / agents / events | In-memory | Postgres or Redis; idempotent agent IDs across restarts. |
| Multi-instance signal-api | Not supported safely | Leader election or shared store. |
| Observability | Console logs | Structured logs, metrics, tracing IDs. |
| CI | Per-package smokes exist | Monorepo workflow matrix running smokes with STANDALONE API in CI. |

### 5.3 Product / UX

| Idea | Why |
|------|-----|
| **Runtime-configurable API base** without rebuild | Already partially addressed via `localStorage` overrides; could add a small settings modal (with warnings). |
| **E2E tests** (Playwright) | Catch proxy misconfigurations and wallet mocks. |
| **Contract cards from registry** | Dashboard already reads **ArgusRegistry** on Sepolia; expand to full agent explorer. |
| **User-facing ENS resolution demo** | Wire a public client + live CCIP read in the UI for the exact `0x…risks…` name used on Sepolia. |
| **Recovery vault** | Mentioned in vision / root README; implement when fund-recovery story is needed. |

### 5.4 TEE / hybrid ergonomics

| Idea | Why |
|------|-----|
| **Documented “one command” profile** | e.g. `docker compose` for tee + api + gw + dashboard for judges. |
| **Named Cloudflare tunnel** in docs | Stable URL for hybrid Railway UI → local TEE without rebuilding dashboard. |

---

## 6. Configuration cheat sheet

### signal-api (representative)

| Variable | Effect |
|----------|--------|
| `STANDALONE=1` | No bridge; in-process consensus. |
| `PORT` | HTTP listen (Railway injects). |
| `DEVICE_HOST` / `DEVICE_PORT` | Bridge target when not standalone. |
| `APIFY_TOKEN` | Enables Twitter path in intel / social agents. |
| `ARGUS_AUTH_STRICT` | Stricter UI messaging around signatures; does **not** grant roles by itself. |
| `ARGUS_PRIVILEGED_ADDRESSES` | Comma-separated wallets that get **Scout** UI without enrollment (deploy / demo team). |
| `ARGUS_ADMIN_ADDRESSES` | Comma-separated wallets allowed for **Admin** tab, enrollment moderation, and signed **demo reset**. **Required** for any admin — there is **no** fallback to the privileged list. |
| `ORBITPORT_*` | Optional hardware-backed nonce path. |

### ens-resolver

| Variable | Effect |
|----------|--------|
| `ARGUS_API` | Upstream signal-api origin. |
| `PORT` | HTTP listen. |
| `ARGUS_FRONTEND_URL_TEMPLATE` | ENS `url` text record template. |

### dashboard

| Variable | Effect |
|----------|--------|
| `VITE_SIGNAL_API` / `VITE_GATEWAY_URL` | Production API bases (build-time). |
| `VITE_API_TARGET` / `VITE_GW_TARGET` | Dev proxy targets. |
| `localStorage` `ARGUS_SIGNAL_API_OVERRIDE` / `ARGUS_GATEWAY_URL_OVERRIDE` | Runtime override for tunnels / hybrid. |

---

## 7. Single paragraph “elevator” status

**Argus today** ships a **credible demo stack**: contributors and agents can push **verified-style signals** into a **TEE-backed or standalone** consensus engine, query **per-contract risk**, expose that risk through an **ENS CCIP gateway**, and operate a **role-aware dashboard** with **intel**, **social polling agents**, and **signed enrollment** — with **explicit server allowlists** separating **scout bypass** from **admin** on hosted APIs. **Automated smokes** cover the watcher and scout pipelines and basic API/gateway wiring; the **full QEMU + demo.ts theatre** remains the gold-path **local** proof. **Railway** hosts a **standalone** triangle (API + gateway + UI) suitable for judges and URLs, while **serious production** still needs **persistence, stricter CORS, signed gateway data, and real attestation policy** aligned with what you claim on stage.

---

*Last updated: access-control model (separate admin vs privileged allowlists, `/access` echo + no-store, client race/cache hardening), EIP-6963-first wallet picker, and Railway env notes. Update when deployment topology or trust claims change.*
