import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests run against the production build (`npm run build` first; `npm run test:e2e` does both).
 * PLAYWRIGHT_CHROMIUM may point at a system Chromium; WebGL uses SwiftShader so it works headless.
 */
const port = process.env.E2E_PORT ?? '4600';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? (process.env.PLAYWRIGHT_BROWSERS_PATH === '/opt/pw-browsers' ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1600, height: 950 },
    launchOptions: { ...(executablePath ? { executablePath } : {}), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    // The simulator's control API comes up only after the recorded history has been seeded.
    url: `http://127.0.0.1:${process.env.E2E_SIM_PORT ?? '4700'}/control/state`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: 'pipe',
  },
});
