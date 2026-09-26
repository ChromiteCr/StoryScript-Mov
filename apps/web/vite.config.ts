import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Served by the Hono server: Vite middleware mode in dev (same port as the
 * API, so no proxy), static `dist/` in production. CSP is `default-src 'self'`:
 * no inline scripts, no data: URIs (assetsInlineLimit 0).
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
