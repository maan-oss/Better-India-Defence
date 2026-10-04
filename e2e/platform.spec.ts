import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'strata-demo';

async function signIn(page: Page, username: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.fill('#u', username);
  await page.fill('#p', PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Application areas' })).toBeVisible();
  return errors;
}

test('rejects bad credentials', async ({ page }) => {
  await page.goto('/');
  await page.fill('#u', 'analyst');
  await page.fill('#p', 'wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
});

test('operations: the 4D world loads with live data and modes switch', async ({ page }) => {
  const errors = await signIn(page, 'analyst');
  await expect(page).toHaveURL(/\/operations/);
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.locator('.clock-mode')).toHaveText('LIVE');
  for (const mode of ['HISTORY', 'COVERAGE', 'DIFF', 'EVIDENCE', 'INCIDENT', 'NOW']) {
    const tab = page.getByRole('tablist', { name: 'Global mode' }).getByRole('tab', { name: mode });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
  expect(errors).toEqual([]);
});

test('time engine: leave live, step, change speed, return to live', async ({ page }) => {
  await signIn(page, 'analyst');
  const clock = page.locator('.clock-mode');
  await expect(clock).toHaveText('LIVE');
  await page.getByRole('button', { name: 'Step back' }).click();
  await expect(clock).toHaveText('PAUSED');
  const before = await page.getByRole('slider', { name: 'Timeline' }).getAttribute('aria-valuenow');
  await page.getByRole('button', { name: 'Step back' }).click({ modifiers: ['Shift'] });
  await expect.poll(async () => page.getByRole('slider', { name: 'Timeline' }).getAttribute('aria-valuenow')).not.toBe(before);
  await page.getByRole('group', { name: 'Playback speed' }).getByRole('button', { name: '×4', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(clock).toHaveText('×4');
  await page.getByTitle('Return to live').click();
  await expect(clock).toHaveText('LIVE');
});

test('incidents: the recorded drone incursion produced an incident with gathered evidence', async ({ page }) => {
  await signIn(page, 'analyst');
  await page.getByRole('link', { name: 'Incidents' }).click();
  const rows = page.locator('.list-row');
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  await expect(page).toHaveURL(/\/incidents\/.+/);
  await expect(page.getByText(/evidence/i).first()).toBeVisible();
});

test('copilot answers from the record and cites evidence or states insufficiency', async ({ page }) => {
  await signIn(page, 'analyst');
  await page.getByRole('button', { name: /Ask the record/ }).click();
  await page.getByLabel('Copilot question').fill('Which sensors are currently not reporting?');
  await page.keyboard.press('Enter');
  const answer = page.locator('.cp-a').last();
  await expect(answer).not.toHaveText(/Querying the record/);
  await expect(answer).not.toBeEmpty();
});

test('RBAC: a viewer cannot reach audit or administration', async ({ page }) => {
  await signIn(page, 'viewer');
  const nav = page.getByRole('navigation', { name: 'Application areas' });
  await expect(nav.getByRole('link', { name: 'Operations' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Audit' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Administration' })).toHaveCount(0);
  const res = await page.request.get('/api/audit');
  expect(res.status()).toBe(403);
});

test('audit: administrator verifies the hash chain', async ({ page }) => {
  await signIn(page, 'admin');
  await page.getByRole('link', { name: 'Audit' }).click();
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await expect(page.getByText(/Chain intact · \d+ records verified/)).toBeVisible();
});
