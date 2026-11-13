import { test, expect } from '@playwright/test';
import { DEMO } from './demo';

test.describe('without a session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a protected page sends you to the login', async ({ page }) => {
    await page.goto('/activity');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a wrong password shows the error and stays on login', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(DEMO.email);
    await page.locator('input[type="password"]').fill('not-the-password');
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect(page.getByText('Credenciales incorrectas')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test('signing out returns to the login and drops the session', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Mi cuenta' }).click();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => localStorage.getItem('llm_obs_token'))).toBeNull();
});
