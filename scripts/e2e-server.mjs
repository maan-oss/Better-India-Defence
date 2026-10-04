#!/usr/bin/env node
/**
 * Server for the Playwright suite: the production build on isolated ports with a fresh embedded database,
 * seeded with ~36 min of recorded scenario history (identity hand-off test + unidentified drone).
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, 'test-results/e2e-data');
rmSync(dir, { recursive: true, force: true });
Object.assign(process.env, {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: process.env.E2E_PORT ?? '4600',
  SIM_PORT: process.env.E2E_SIM_PORT ?? '4700',
  SIM_URL: `http://127.0.0.1:${process.env.E2E_SIM_PORT ?? '4700'}`,
  DATA_DIR: resolve(dir, 'db'),
  SIM_STATE_FILE: resolve(dir, 'sim-state.json'),
  SEED_MINUTES: '36',
  STRATA_SERVICE_TOKEN: 'e2e-service-token-0123456789',
  STRATA_DEMO_USERS: 'true',
  COPILOT_PROVIDER: 'deterministic',
  LOG_LEVEL: 'warn',
});
await import('./start.mjs');
