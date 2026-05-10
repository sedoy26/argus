import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Proxy /api → signal-api and /gw → ens-resolver gateway.
//
// Defaults match `bun run dev` in each service: signal-api :8787,
// ens-resolver :8788. If you use `reset.sh`, it often runs signal-api
// on :8788 and the gateway on :8789 — then start Vite with:
//   VITE_API_TARGET=http://127.0.0.1:8788 VITE_GW_TARGET=http://127.0.0.1:8789 bun run dev
//
// For production deploys point /api and /gw at the hosted endpoints
// in your reverse proxy / CDN.

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8787';
const GW_TARGET = process.env.VITE_GW_TARGET ?? 'http://127.0.0.1:8788';

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
