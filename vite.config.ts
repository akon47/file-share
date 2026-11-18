import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const serverPort = Number(process.env.PORT ?? 8080);

// The web app lives in src/web and is served by the Node server from dist/web in production.
// In development Vite serves it and proxies the signaling WebSocket (/ws) and /healthz to the server.
export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  publicDir: fileURLToPath(new URL('./src/web/public', import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/web', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      '/healthz': { target: `http://127.0.0.1:${serverPort}` },
    },
  },
});
