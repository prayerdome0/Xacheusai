import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The console talks to the backend over relative URLs (/api/...) and Vite proxies
 * them, so the browser never needs to know the backend's address. That also means
 * the same build works behind any host — including the sandbox preview proxy —
 * without CORS or host-allowlist problems.
 */
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // Allow preview hosts (*.e2b.app) and any tunnel the owner points at it.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.XACHEUS_API_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
