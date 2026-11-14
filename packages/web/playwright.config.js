import { defineConfig, devices } from '@playwright/test';

// Own ports so a running `npm run dev` (3001/5173, dev DB) is never reused.
const API_PORT = process.env.E2E_API_PORT || '3101';
const WEB_PORT = process.env.E2E_WEB_PORT || '5174';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: 'es-ES',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.js/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/demo.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: [
    {
      command: 'node e2e/start-api.mjs',
      url: `http://localhost:${API_PORT}/health`,
      env: { E2E_API_PORT: API_PORT },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Same-origin through Vite's proxy, like nginx does in production.
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      reuseExistingServer: !process.env.CI,
    },
  ],
});
