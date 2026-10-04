import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.STRATA_API ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/metrics': { target: api },
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: { output: { manualChunks: { three: ['three'], react: ['react', 'react-dom', 'react-router-dom'] } } },
  },
});
