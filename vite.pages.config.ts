import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./standalone', import.meta.url)),
  base: process.env.PAGES_BASE_PATH || '/stafftrack/',
  plugins: [react()],
  resolve: { alias: {
    '@': projectRoot,
    'cloudflare:workers': fileURLToPath(new URL('./standalone/bindings.ts', import.meta.url)),
  } },
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  css: { postcss: projectRoot },
  build: {
    outDir: fileURLToPath(new URL('./dist-pages', import.meta.url)),
    emptyOutDir: true,
  },
});
