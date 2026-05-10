# Argus

**The hundred-eyed guardian of Web3.**

A TEE-verified security intelligence network for Ethereum. Watchers report threats, the platform verifies them inside a Trusted Execution Environment against Sourcify source code, and risk scores are published via ENS so any wallet can check any contract. Autonomous guardians revoke approvals using keys that no operator can extract.

Built for **ETHPrague 2026**.

## The trust stack

| Layer | Trust guarantee | Sponsor tech |
|---|---|---|
| Consensus | Computed by attested code in TrustZone | SpaceComputer GoTEE (QEMU → USB Armory) |
| Verification | Cross-checked against actual source | Sourcify API + Parquet/BigQuery |
| Distribution | Resolvable by any ENS-aware client | ENS CCIP-Read wildcard resolver |
| Execution | Signing key unreachable by operator | SpaceComputer KMS |
| Intelligence | Off-chain feeds paid per-request | Apify + X402 |

See [`architecture-vision.md`](./architecture-vision.md) for the full design.

## Repo layout

```
contracts/        Solidity — FakeSwapNet, MockUSDC, ArgusRegistry, RecoveryVault
platform/
  tee/            GoTEE Trusted Applet (Rust) + Normal World host (Go)
  signal-api/     Signal submission endpoint
  ens-resolver/   CCIP-Read wildcard gateway
  risk-db/        Risk score storage
agents/
  watcher-sourcify/  Source-code pattern detector
  watcher-onchain/   On-chain event monitor
  scout-apify/       X402-paid intelligence scraper
  guardian/          KMS-signed protection agent
dashboard/        React + Vite frontend
scripts/          Deploy, setup, demo helpers
presentation/     Slides + backup demo video
```

## Quickstart

Components are independent — each subdirectory has its own setup. See per-component READMEs once added.

For pre-hackathon prep checklist, see Section 8 of `architecture-vision.md`.

## Railway: deploy from GitHub (no manual deploys)

Railway does **not** read GitHub settings from `railway.toml`; each service must be **connected to the repo** with **automatic deployments** turned on.

1. **GitHub App access** — In GitHub: [Settings → Applications → Railway](https://github.com/settings/installations) → Configure → ensure this repository is allowed (and accept any pending permission updates).
2. **Link the repo per service** — In Railway: open the **dashboard** and **signal-api** services (and any others) → **Settings** → **Source** → connect the same GitHub repository and set the deploy branch (e.g. `main`).
3. **Enable autodeploy** — On that Source screen, ensure **automatic deployments** are **Enabled** (if they were disabled after a permissions glitch, re-enable after fixing GitHub access). See [Controlling GitHub autodeploys](https://docs.railway.com/guides/github-autodeploys).
4. **Monorepo root directory + config file** — For each service, set **Root directory** (e.g. `dashboard/`, `platform/signal-api/`, `platform/ens-resolver/`). Railway does **not** resolve `railway.toml` relative to that root: in **Settings → Build → Config file path**, set the path from the repo root, e.g. `/dashboard/railway.toml`, `/platform/signal-api/railway.toml`, `/platform/ens-resolver/railway.toml`.
5. **Watch paths** — Each service’s `railway.toml` in this repo sets **`watchPatterns`** so a push only rebuilds services whose tree changed (e.g. `dashboard/**`, `platform/signal-api/**`). That keeps GitHub autodeploy fast and reliable. If you change only files outside those trees (e.g. top-level `README.md`), Railway may **skip** builds; use **Deploy Latest Commit** for a one-off, or temporarily widen/remove `watchPatterns` in the service you want to rebuild.

After this, **`git push` to the connected branch** is enough; use **Deploy Latest Commit** in the command palette only when recovering from a skipped build or a doc-only change.

### Automate GitHub + monorepo settings (Railway GraphQL API)

One-time browser steps still required: [install the Railway GitHub App](https://github.com/settings/installations) and grant it access to your repository.

Then you can wire **repo, branch, root directory, `railway.toml` path, and autodeploy** for each existing service from this repo:

1. Put your Railway **API token in the shell only** (never in `railway.deploy.config.json`):
   - [Account or workspace token](https://railway.com/account/tokens) → `export RAILWAY_API_TOKEN="…"` (sent as `Authorization: Bearer`), or
   - **Project token** from the project → `export RAILWAY_PROJECT_ACCESS_TOKEN="…"` (sent as `Project-Access-Token`; see [tokens](https://docs.railway.com/guides/public-api#creating-a-token)).
2. Edit `scripts/railway/railway.deploy.config.json` (tracked defaults for this repo: `projectId`, `doy26/argus`, service `matchName`s). Forks should change `projectId` / `githubRepo` / `matchName` as needed.
3. From the repo root:

```bash
export RAILWAY_API_TOKEN="…"   # or: export RAILWAY_PROJECT_ACCESS_TOKEN="…"
export RAILWAY_PROJECT_ID="…"   # optional if projectId is set in railway.deploy.config.json
# optional: export RAILWAY_ENVIRONMENT_ID="…"  # Railway *environment* UUID only (not an API key)
# optional: export RAILWAY_ENVIRONMENT_NAME=staging   # default picks "production" or first env

cd scripts && bun run railway:configure-autodeploy
# preview:   bun run railway:configure-autodeploy --dry-run
# discover:  bun run railway:list
# redeploy:  bun run railway:configure-autodeploy --deploy
```

Implementation: `scripts/railway/configure-github-autodeploy.ts` → Railway public API at `https://backboard.railway.com/graphql/v2` (`serviceConnect`, `serviceInstanceUpdate`, `serviceInstanceAutoDeployUpdate`, optional `serviceInstanceDeploy`). See [Public API](https://docs.railway.com/guides/public-api).

If you see **`User does not have access to the repo`**, the [Railway GitHub App](https://github.com/settings/installations) must be allowed to access that repository (add `owner/repo` under Repository access). If each service **already** has the correct GitHub repo in the Railway UI, run with **`--skip-connect`** to apply only monorepo paths + autodeploy.

If GitHub deploys trigger but **Build image** fails quickly, open **Build logs** on the deployment. This repo’s `railway.toml` files must not set `builder = "nixpacks"` — [Railway config-as-code](https://docs.railway.com/reference/config-as-code) only documents **`RAILPACK`** and **`DOCKERFILE`**; an invalid builder value can fail the build phase.
