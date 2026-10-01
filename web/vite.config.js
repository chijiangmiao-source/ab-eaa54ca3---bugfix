import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During local `vite dev`, /api and /healthz are proxied to the backend.
// In production the Node server hosts this built bundle directly.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
