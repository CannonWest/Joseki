import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Resolve the shared workspace package to its TypeScript source
      // so Vite processes it through its transform pipeline
      '@maestroai/shared': path.resolve(__dirname, '../shared/src/index.ts')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'ws://localhost:3001',
        ws: true
      }
    }
  },
  optimizeDeps: {
    include: ['@maestroai/shared']
  }
});
