import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:3001',
        changeOrigin: true
      },
      '/socket.io': {
        target: process.env.VITE_API_URL || 'http://localhost:3001',
        ws: true
      }
    }
  },
  test: {
    environment: 'jsdom',
    // Only unit/component tests; Playwright specs live in e2e/ and run separately.
    include: ['src/**/*.test.{js,mjs,jsx}'],
    setupFiles: ['./src/test/setup.js'],
    // Node 25+ ships a built-in localStorage that shadows jsdom's (and is
    // undefined without --localstorage-file); turn it off in test workers.
    poolOptions: { forks: { execArgv: ['--no-experimental-webstorage'] } },
  }
});
