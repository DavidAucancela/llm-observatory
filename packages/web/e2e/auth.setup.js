import { test as setup, expect } from '@playwright/test';
import { DEMO } from './demo';

// Logs in once as the demo user and saves the session so the other specs
// start authenticated.

setup('log in as the demo user', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(DEMO.email);
  await page.locator('input[type="password"]').fill(DEMO.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.context().storageState({ path: 'e2e/.auth/demo.json' });
});
