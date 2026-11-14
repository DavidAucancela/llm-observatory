import { test, expect } from '@playwright/test';

const rows = page => page.locator('table.obs-table tbody tr');

test('Requests lists the demo calls', async ({ page }) => {
  await page.goto('/activity');
  // seed:demo spreads its calls over the last 30 days; the default 7d range has some.
  await expect(rows(page).first().locator('td').nth(2)).not.toBeEmpty();
  await expect(page.locator('.obs-skeleton')).toHaveCount(0);
  expect(await rows(page).count()).toBeGreaterThan(1);
});

// Regression for #87: a "View requests" deep link opens on its own range
// without overwriting the range the other pages remember.
test('a deep-link range is used but not saved', async ({ page }) => {
  await page.goto('/dashboard');
  await page.evaluate(() => {
    localStorage.setItem('obs-range', '30d');
    localStorage.removeItem('obs-range-start');
    localStorage.removeItem('obs-range-end');
  });

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const metricsCall = page.waitForRequest(r =>
    r.url().includes('/api/metrics?') && new URL(r.url()).searchParams.get('range') === 'custom');
  await page.goto(`/activity?start=${weekAgo}&end=${today}`);

  const params = new URL((await metricsCall).url()).searchParams;
  expect(params.get('start')).toContain(weekAgo);
  expect(params.get('end')).toContain(today);

  expect(await page.evaluate(() => [
    localStorage.getItem('obs-range'),
    localStorage.getItem('obs-range-start'),
    localStorage.getItem('obs-range-end'),
  ])).toEqual(['30d', null, null]);
});
