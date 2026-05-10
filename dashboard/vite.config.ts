import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Proxy /api → signal-api and /gw → ens-resolver gateway.
//
// Priority: VITE_API_TARGET / VITE_GW_TARGET env, then ARGUS_API / ARGUS_GATEWAY
// from repo `scripts/.env` (same keys as demos), then defaults :8787 / :8788.
// Override with `bun run dev:reset` or explicit VITE_* when ports differ.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readArgusFromScriptsEnv(): { api?: string; gw?: string } {
  const p = path.join(repoRoot, 'scripts', '.env');
  if (!existsSync(p)) return {};
  const out: { api?: string; gw?: string } = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const am = t.match(/^ARGUS_API=(.+)$/);
    if (am) out.api = am[1].trim().replace(/^["']|["']$/g, '');
    const gm = t.match(/^ARGUS_GATEWAY=(.+)$/);
    if (gm) out.gw = gm[1].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const fromScripts = readArgusFromScriptsEnv();
const API_TARGET = process.env.VITE_API_TARGET ?? fromScripts.api ?? 'http://127.0.0.1:8787';
const GW_TARGET = process.env.VITE_GW_TARGET ?? fromScripts.gw ?? 'http://127.0.0.1:8788';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/gw': {
        target: GW_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gw/, ''),
      },
    },
  },
});
