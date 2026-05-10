# Argus dashboard

React + Vite + Tailwind 4. Polls `signal-api` and `ens-resolver`
every 3 seconds, displays a per-address risk grid, and includes a
manual signal-submission form for stage demos.

```
[ Argus  ●bridge   code 0x….  signals 7/256 ]
─────────────────────────────────────────────
 watchlist   |   contract grid (sorted CRITICAL → NONE)
   add 0x…   |    ┌── card ───┐  ┌── card ───┐
             |    │ 0x…  RED  │  │ 0x…  NONE │
   0xdead…   |    │ 2/3  60   │  │ 0/0  0    │
             |    └───────────┘  └───────────┘
   manual    |
   signal    |   detail panel (envelope + ENS records)
   form      |
```

## Running

```bash
bun install
bun run dev    # http://localhost:5173
```

The Vite dev server proxies:
- `/api/*` → signal-api (default `http://127.0.0.1:8787`)
- `/gw/*` → ens-resolver gateway (default `http://127.0.0.1:8788`)

so the SPA fetches from same-origin paths and avoids any CORS dance.

**Ports:** If the repo root `scripts/.env` defines `ARGUS_API` / `ARGUS_GATEWAY`, Vite uses those for the proxy (same values as `reset.sh` demos). Otherwise set `VITE_API_TARGET` / `VITE_GW_TARGET`, or run `bun run dev:reset` when using `./reset.sh` on **8788** / **8789**.

If `/api` points at the wrong process you may see **404** on new routes; if nothing is listening on the proxy target you may see **500** with an empty body after connecting a wallet.

## Production build

Set **build-time** env (e.g. on Railway) so the SPA calls your APIs directly:

- `VITE_SIGNAL_API` — origin only, e.g. `https://argus-signal-api-production.up.railway.app`
- `VITE_GATEWAY_URL` — e.g. `https://argus-gateway-production.up.railway.app`

Then:

```bash
bun install
bun run build
bun run start   # serves ./dist on $PORT (Railway)
```

Omit both variables in dev to keep using the Vite `/api` and `/gw` proxies.

## Demo flow

1. Open the dashboard.
2. In another shell: `cd ../scripts && bun run demo`. The dashboard
   updates live as scout → sourcify → onchain submit and the score
   badge animates `NONE` → `ORANGE` → `RED` → `CRITICAL`.
3. (Optional) Use the **manual signal** form to drive arbitrary
   contracts to arbitrary scores from the audience-facing screen.

Watched addresses persist in `localStorage` under `argus.watched.v1`.
