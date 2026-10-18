import { expect, test, type Page } from '@playwright/test';

/**
 * Visual regression for the screens whose layout matters most. Live areas (the animated globe, the status island, the
 * clock, animated counters) are masked so the baseline holds still; everything else must match within 2 % of pixels.
 * Baselines are for the reference environment (Linux, the bundled Chromium, fonts shipped with the app). Regenerate with
 * `npx playwright test e2e/visual.spec.ts --update-snapshots` after an intended visual change, and review the images.
 */
const LIVE = ['canvas', 'button.island', '.hero-clock', '.as-metrics', '.live-dot'];

async function signInAs(page: Page, username: string) {
  await page.goto('/');
  await page.fill('#u', username);
  await page.fill('#p', 'strata-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Application areas' })).toBeVisible();
}

test('sign-in page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#u')).toBeVisible();
  await expect(page).toHaveScreenshot('sign-in.png', { mask: LIVE.map((s) => page.locator(s)), maxDiffPixelRatio: 0.02, animations: 'disabled' });
});

test('asset register', async ({ page }) => {
  await signInAs(page, 'analyst');
  // A known record, so the list has the same content on every run.
  await page.request.post('/api/assets', { data: { tag: 'VIS-PUMP', name: 'Visual baseline pump', category: 'facilities', criticality: 3 } });
  await page.goto('/assets');
  await expect(page.locator('ul[aria-label="Assets"] li').first()).toBeVisible();
  await expect(page).toHaveScreenshot('assets.png', { mask: LIVE.map((s) => page.locator(s)), maxDiffPixelRatio: 0.02, animations: 'disabled' });
});

test('incident reports', async ({ page }) => {
  await signInAs(page, 'operator');
  await page.goto('/reports');
  await expect(page.locator('h1', { hasText: 'Incident reports' })).toBeVisible();
  await expect(page).toHaveScreenshot('incident-reports.png', { mask: LIVE.map((s) => page.locator(s)), maxDiffPixelRatio: 0.02, animations: 'disabled' });
});

test('documents', async ({ page }) => {
  await signInAs(page, 'operator');
  await page.goto('/documents');
  await expect(page.locator('h1', { hasText: 'Documents' })).toBeVisible();
  await expect(page).toHaveScreenshot('documents.png', { mask: LIVE.map((s) => page.locator(s)), maxDiffPixelRatio: 0.02, animations: 'disabled' });
});
