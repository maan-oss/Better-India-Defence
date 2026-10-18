import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

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

async function createAsset(api: APIRequestContext, tag: string, name: string, category: string, criticality: number): Promise<string> {
  const r = await api.post('/api/assets', { data: { tag, name, category, criticality } });
  expect(r.ok()).toBeTruthy();
  return ((await r.json()) as { asset: { id: string } }).asset.id;
}

/** A run-unique suffix, so the tests can run against a database that already holds earlier runs. */
const suffix = () => Date.now().toString(36).slice(-5).toUpperCase();

test('assets: a fault shows what it takes down, and the record names every change', async ({ page }) => {
  const errors = await signIn(page, 'analyst');
  const s = suffix();
  const feeder = `E2E-PWR-${s}`;
  const rack = `E2E-RACK-${s}`;
  const feederId = await createAsset(page.request, feeder, 'E2E feeder', 'power', 5);
  const rackId = await createAsset(page.request, rack, 'E2E rack', 'it', 5);
  const dep = await page.request.put(`/api/assets/${rackId}/dependencies`, { data: { dependsOn: [{ id: feederId, kind: 'power' }] } });
  expect(dep.ok()).toBeTruthy();

  await page.goto(`/assets/${feederId}`);
  await expect(page.getByRole('heading', { name: 'E2E feeder' })).toBeVisible();
  await page.getByRole('tab', { name: 'Impact' }).click();
  await expect(page.getByText(/1 asset would change state/)).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Impact' }).getByText(rack)).toBeVisible();

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByLabel('New status').selectOption('out_of_service');
  await page.getByLabel('Reason').fill('Feeder breaker tripped');
  await page.getByRole('button', { name: 'Record status' }).click();
  await expect(page.getByText('Out of service. The fault is its own; nothing upstream is involved.')).toBeVisible();

  await page.goto(`/assets/${rackId}`);
  await expect(page.getByText(`Working, but cut off from ${feeder}.`)).toBeVisible();
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByText(`Needs ${feeder}`)).toBeVisible();
  expect(errors).toEqual([]);
});

test('assets: a viewer reads the register and sees no controls for changing it', async ({ page, baseURL }) => {
  const analyst = await request.newContext({ baseURL });
  const login = await analyst.post('/api/auth/login', { data: { username: 'analyst', password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const id = await createAsset(analyst, `E2E-VIEW-${suffix()}`, 'E2E viewable asset', 'other', 2);
  await analyst.dispose();

  const errors = await signIn(page, 'viewer');
  await page.goto(`/assets/${id}`);
  await expect(page.getByRole('heading', { name: 'E2E viewable asset' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record status' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retire asset' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Dependencies' }).click();
  await expect(page.getByRole('button', { name: 'Edit dependencies' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
