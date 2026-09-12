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
    include: ['@joseki/shared']
  }
});
