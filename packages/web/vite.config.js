import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// API_PROXY_TARGET lets the E2E run point the proxy at its own API port
// without inlining a cross-origin VITE_API_URL into the client bundle.
const apiTarget = process.env.API_PROXY_TARGET || process.env.VITE_API_URL || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true
      },
      '/socket.io': {
        target: apiTarget,
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
