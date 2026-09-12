import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Where this dev server proxies the API and the socket. The default is the
// server's own default port, so `npm run dev` is unchanged; set it (with
// `vite --port`) to run a second client against a second server out of the
// same checkout.
const SERVER_URL = process.env.JOSEKI_SERVER_URL || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Resolve the shared workspace package to its TypeScript source
      // so Vite processes it through its transform pipeline
      '@joseki/shared': path.resolve(__dirname, '../shared/src/index.ts')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: SERVER_URL,
        changeOrigin: true
      },
      '/health': {
        target: SERVER_URL,
        changeOrigin: true
      },
      '/socket.io': {
        target: SERVER_URL.replace(/^http/, 'ws'),
        ws: true
      }
    }
  },
  optimizeDeps: {
    // The alias above points at shared's TypeScript source, so Vite should
    // transform it like any file in this app and pick edits up at once.
    // Pre-bundling it fought that: the dep snapshot froze at whatever shared
    // exported when the cache was built, and Vite invalidates a linked
    // package on its manifest, never its contents — so a new export in
    // shared meant "does not provide an export named ..." until someone
    // deleted node_modules/.vite by hand. Excluded, there is no snapshot to
    // go stale.
    exclude: ['@joseki/shared']
  }
});
