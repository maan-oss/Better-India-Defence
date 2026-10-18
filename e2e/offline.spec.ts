import { expect, test } from '@playwright/test';

/**
 * The application needs no network beyond its own server. Every request the page makes must stay on that server (data
 * and blob URLs are local to the page). Anything else is aborted and recorded, and the test fails with the addresses. The
 * sign-in and the main pages are exercised with that block in place, so a resource the application needs from outside
 * would stop the page here.
 */
const PAGES = ['/operations', '/assets', '/reports', '/documents', '/incidents', '/system'];

test('every request stays on the local server, and the main pages still work', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const blocked: string[] = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === origin) return route.continue();
    blocked.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/');
  await page.fill('#u', 'analyst');
  await page.fill('#p', 'strata-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Application areas' })).toBeVisible();

  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.locator('.page, canvas, h1').first()).toBeVisible({ timeout: 20_000 });
  }
  expect(blocked, `blocked requests: ${blocked.join(', ')}`).toEqual([]);
  expect(pageErrors).toEqual([]);
});

/**
 * A second layer, independent of the route block: the page's own policy refuses a connection to another origin. A
 * script that tries one is refused and the browser reports it, so the policy is shown to work and not only assumed.
 */
test('the page policy refuses a connection to another origin', async ({ page }) => {
  const messages: string[] = [];
  page.on('console', (m) => messages.push(m.text()));
  await page.goto('/');
  await page.evaluate(() => fetch('https://example.invalid/probe').then(() => 'reached', (e: unknown) => String(e)));
  await expect.poll(() => messages.some((m) => /Content Security Policy|Refused to connect/i.test(m)), { timeout: 10_000 }).toBe(true);
});
