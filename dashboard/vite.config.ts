import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Proxy /api → signal-api and /gw → ens-resolver gateway.
//
// The TEE-connected signal-api runs on :8788 locally (we use 8787
// only in the pure standalone / Railway mode). Override with
// VITE_API_TARGET and VITE_GW_TARGET env vars if your ports differ.
//
// For production deploys point /api and /gw at the hosted endpoints
// in your reverse proxy / CDN.

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8788';
const GW_TARGET = process.env.VITE_GW_TARGET ?? 'http://127.0.0.1:8789';

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
