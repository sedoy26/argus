import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Proxy /api → signal-api (:8787) and /gw → ens-resolver gateway (:8788)
// so the SPA can fetch from same-origin paths and avoid CORS during
// development. For production deploys point /api and /gw at the
// hosted endpoints in your reverse proxy / CDN.

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/gw': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gw/, ''),
      },
    },
  },
});
