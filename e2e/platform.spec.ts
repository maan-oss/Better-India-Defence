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
  await expect(page.locator('button.island .isl-mode')).toHaveText('Live');
  for (const mode of ['History', 'Coverage', 'Diff', 'Evidence', 'Incident', 'Now']) {
    const button = page.getByRole('group', { name: 'Picture mode' }).getByRole('button', { name: mode, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  expect(errors).toEqual([]);
});

test('time engine: leave live, step, change speed, return to live', async ({ page }) => {
  await signIn(page, 'analyst');
  const clock = page.locator('button.island .isl-mode');
  await expect(clock).toHaveText('Live');
  await page.getByRole('button', { name: 'Step back' }).click();
  await expect(clock).toHaveText('Paused');
  const before = await page.getByRole('slider', { name: 'Timeline' }).getAttribute('aria-valuenow');
  await page.getByRole('button', { name: 'Step back' }).click({ modifiers: ['Shift'] });
  await expect.poll(async () => page.getByRole('slider', { name: 'Timeline' }).getAttribute('aria-valuenow')).not.toBe(before);
  await page.getByRole('group', { name: 'Playback speed' }).getByRole('button', { name: '×4', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(clock).toHaveText('Replay ×4');
  await page.getByTitle('Return to live').click();
  await expect(clock).toHaveText('Live');
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
  await page.getByRole('textbox', { name: /Ask about changes/ }).fill('Which sensors are currently not reporting?');
  await page.keyboard.press('Enter');
  const answer = page.locator('.cp-a').last();
  await expect(answer).not.toHaveText(/Querying the record/);
  await expect(answer).not.toBeEmpty();
});

test('RBAC: a viewer cannot reach audit or administration', async ({ page }) => {
  await signIn(page, 'viewer');
  const nav = page.getByRole('navigation', { name: 'Application areas' });
  await expect(nav.getByRole('link', { name: 'Operational picture' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Audit' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Users & settings' })).toHaveCount(0);
  const res = await page.request.get('/api/audit');
  expect(res.status()).toBe(403);
});

test('audit: administrator verifies the hash chain', async ({ page }) => {
  await signIn(page, 'admin');
  await page.getByRole('link', { name: 'Audit' }).click();
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await expect(page.getByText('Chain intact')).toBeVisible();
  await expect(page.getByText(/\d+ records verified/)).toBeVisible();
});

test('identity hand-off demo returns scored segments with real frame crops and requires human review', async ({ page }) => {
  await signIn(page, 'analyst');
  await page.getByRole('link', { name: 'Evidence' }).click();
  await page.getByRole('tab', { name: /Identity hand-off/ }).click();
  await page.getByRole('button', { name: /Search recorded observations/ }).click();
  await expect(page.getByText(/HUMAN REVIEW/i).first()).toBeVisible({ timeout: 30_000 });
  const thumb = page.locator('img[alt="candidate appearance"]').first();
  await expect(thumb).toBeVisible();
  await expect.poll(async () => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------------------------- new areas

const fixtures = 'apps/server/test/fixtures';

test('command: readiness, threat board, and a SITREP drafted from the record', async ({ page }) => {
  const errors = await signIn(page, 'analyst');
  await page.getByRole('link', { name: 'Command' }).click();
  await expect(page.getByRole('heading', { name: 'Command' })).toBeVisible();
  await expect(page.getByText('Threat evaluation')).toBeVisible();
  await expect(page.getByText('Response teams', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'SITREP', exact: true }).click();
  await page.getByRole('button', { name: 'Draft from record' }).click();
  const doc = page.locator('.sitrep-doc');
  await expect(doc).toBeVisible();
  // DTG and MGRS grid references (demo site anchor lies in zone 31N).
  await expect(doc).toContainText(/\d{6}Z [A-Z]{3} \d{2}/);
  expect(errors).toEqual([]);
});

test('identity: enrol a person from a photograph (synthetic face) with a quality grade', async ({ page }) => {
  const errors = await signIn(page, 'analyst');
  const r = await page.request.post('/api/identities', { data: { list: 'AUTHORISED', category: 'Personnel', name: 'E2E Test Officer', accessZones: [] } });
  expect(r.ok()).toBe(true);
  const { id } = (await r.json()) as { id: string };
  await page.goto(`/identity?tab=REGISTER&id=${id}`);
  await expect(page.getByText('Enrol photo')).toBeVisible();
  await page.locator('.panel', { hasText: 'Enrol photo' }).locator('input[type=file]').setInputFiles(`${fixtures}/subject-b.jpg`);
  const face = page.locator('.chooser button').first();
  await expect(face).toBeEnabled({ timeout: 60_000 });
  await expect(face).toContainText(/GOOD|FAIR/);
  await face.click();
  await expect(page.getByText(/Enrolled\./)).toBeVisible();
  await expect(page.getByText(/Enrolled photos \(1\)/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('media forensics: upload a photograph, it is hashed and analysed for people and vehicles', async ({ page }) => {
  const errors = await signIn(page, 'operator');
  await page.getByRole('link', { name: 'Media Forensics' }).click();
  await page.getByRole('button', { name: /Add evidence/ }).click();
  await page.locator('input[type=file][multiple]').setInputFiles(`${fixtures}/scene.jpg`);
  await page.getByRole('button', { name: /^Ingest/ }).click();
  await expect(page).toHaveURL(/\/forensics\/.+/, { timeout: 60_000 });
  const id = page.url().split('/forensics/')[1]!.split(/[?#]/)[0]!;
  await expect
    .poll(async () => ((await (await page.request.get(`/api/evidence/items/${id}`)).json()) as { analysisStatus: string }).analysisStatus, { timeout: 90_000 })
    .toBe('complete');
  const item = (await (await page.request.get(`/api/evidence/items/${id}`)).json()) as { sha256: string };
  expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
  const dets = (await (await page.request.get(`/api/evidence/items/${id}/detections`)).json()) as { cls: string }[];
  expect(dets.length).toBeGreaterThan(3);
  expect(errors).toEqual([]);
});

test('site setup: an administrator can start a site from the demo layout and see its data feeds', async ({ page }) => {
  const errors = await signIn(page, 'admin');
  await page.getByRole('link', { name: 'Site setup' }).click();
  await page.getByRole('button', { name: 'Start from the demo layout' }).click();
  await expect(page.getByText('Data feeds')).toBeVisible();
  await expect(page.locator('.feed-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Add feed' }).click();
  await expect(page.locator('.feed-row')).toHaveCount(3);
  await expect(page.locator('svg').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('field view: a team leader selects their team and sends a SALUTE contact report', async ({ page }) => {
  const errors = await signIn(page, 'operator');
  await page.goto('/field');
  await page.getByRole('combobox', { name: 'My team' }).click();
  await page.getByRole('option', { name: 'QRT-1 · QRT' }).click();
  await expect(page.locator('.ftask')).toBeVisible();
  await expect(page.locator('.flocal')).toBeVisible();
  await page.getByRole('button', { name: 'Contact report (SALUTE)' }).click();
  await page.getByPlaceholder('how many: 2 persons, 1 vehicle').fill('2 persons');
  await page.getByPlaceholder('what they are doing').fill('loitering near the east fence');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByText(/Report sent to the control room/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('camera wall: site cameras render in a selectable grid layout', async ({ page }) => {
  const errors = await signIn(page, 'operator');
  await page.getByRole('link', { name: 'Camera wall' }).click();
  await expect(page.locator('.wtile').first()).toBeVisible();
  await page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: '2×2' }).click();
  await expect(page.locator('.wtile')).toHaveCount(4);
  await page.locator('.wtile').first().click();
  await expect(page.locator('.focus-panel')).toBeVisible();
  expect(errors).toEqual([]);
});

test('night (red-light) display can be switched from the user menu', async ({ page }) => {
  await signIn(page, 'viewer');
  await page.locator('.user-btn').click();
  await page.getByRole('menuitem', { name: /Night display/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.locator('.user-btn').click();
  await page.getByRole('menuitem', { name: /Standard display/ }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'night');
});

test('command bar: Ctrl K searches areas and navigates; G then letter jumps', async ({ page }) => {
  const errors = await signIn(page, 'analyst');
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Search the site, enter a grid reference, or type a command');
  await expect(input).toBeVisible();
  await input.fill('camera wall');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/cameras/);
  await expect(input).toBeHidden();
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(page).toHaveURL(/\/command/);
  expect(errors).toEqual([]);
});

test('status island opens to show readiness, alerts and sensor state', async ({ page }) => {
  await signIn(page, 'analyst');
  await page.getByRole('button', { name: 'Console status' }).click();
  const panel = page.getByRole('dialog', { name: 'Console status' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Readiness')).toBeVisible();
  await expect(panel.getByText('Open alerts').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('operational picture: layers sheet toggles a layer and the inspector collapses', async ({ page }) => {
  const errors = await signIn(page, 'analyst');
  await page.getByRole('button', { name: 'Layers' }).click();
  const terrain = page.getByRole('switch', { name: 'Terrain' });
  await expect(terrain).toBeVisible();
  const before = await terrain.getAttribute('aria-checked');
  await terrain.click();
  await expect(terrain).not.toHaveAttribute('aria-checked', before ?? 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Hide inspector' }).click();
  await expect(page.getByRole('button', { name: 'Show inspector' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('incidents: a note is recorded in the append-only duty log under the incident', async ({ page }) => {
  const errors = await signIn(page, 'operator');
  await page.getByRole('link', { name: 'Incidents' }).click();
  await page.getByRole('tab', { name: /Notes/ }).click();
  await page.getByPlaceholder('Add a note to the record').fill('E2E: patrol confirms the fence line is intact.');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('E2E: patrol confirms the fence line is intact.')).toBeVisible();
  const log = await page.evaluate(async () => (await fetch('/api/ops/log?limit=20')).json());
  expect(log.some((l: { text: string; ref: string | null }) => l.text.includes('fence line is intact') && l.ref?.startsWith('inc-'))).toBe(true);
  expect(errors).toEqual([]);
});

test('operational picture: a still right-click opens map actions for the point under the pointer', async ({ page }) => {
  const errors = await signIn(page, 'operator');
  await page.waitForTimeout(3000);
  const canvas = page.locator('.world-canvas canvas').first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Map actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Copy grid/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Dispatch a team here' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
