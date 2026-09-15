import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The console talks to the backend over relative URLs (/api/...) and Vite proxies
 * them, so the browser never needs to know the backend's address. That also means
 * the same build works behind any host — including the sandbox preview proxy —
 * without CORS or host-allowlist problems.
 */
export default defineConfig({
  // Resolve root and outDir relative to this config file so builds work the
  // same whether Vite is invoked from apps/web (dev) or the repo root
  // (npm workspaces, Vercel build command, `npx vite build -c ...`).
  root: __dirname,
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
  // Output to the repo-root dist/ folder. Vercel defaults its Output Directory
  // to "dist" and a root-level folder is unambiguous in an npm-workspace
  // monorepo (nested apps/*/dist paths can get tripped up by zero-config
  // heuristics, especially if Root Directory is mis-set in the dashboard).
  build: { outDir: path.resolve(__dirname, '../../dist'), emptyOutDir: true, sourcemap: true, target: 'es2022' },
});
