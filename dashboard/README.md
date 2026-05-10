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
- `/api/*` → `http://127.0.0.1:8787` (signal-api)
- `/gw/*` → `http://127.0.0.1:8788` (ens-resolver gateway)

so the SPA fetches from same-origin paths and avoids any CORS dance.

**Port mismatch:** `reset.sh` starts signal-api on **8788** and the ENS gateway on **8789**. If you use that script, start the dashboard with:

`bun run dev:reset` (same as setting `VITE_API_TARGET` / `VITE_GW_TARGET` for ports **8788** / **8789**), or the equivalent `VITE_API_TARGET=http://127.0.0.1:8788 VITE_GW_TARGET=http://127.0.0.1:8789 bun run dev`.

If `/api` points at the wrong process you may see **404** on `/access`; if nothing is listening on the proxy target you may see **500** with an empty body after connecting a wallet.
For production you'd point `/api` and `/gw` at your hosted endpoints
through a reverse proxy.

## Demo flow

1. Open the dashboard.
2. In another shell: `cd ../scripts && bun run demo`. The dashboard
   updates live as scout → sourcify → onchain submit and the score
   badge animates `NONE` → `ORANGE` → `RED` → `CRITICAL`.
3. (Optional) Use the **manual signal** form to drive arbitrary
   contracts to arbitrary scores from the audience-facing screen.

Watched addresses persist in `localStorage` under `argus.watched.v1`.
