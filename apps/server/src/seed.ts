import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { Platform } from './platform.ts';
import { buildApp } from './app.ts';

/**
 * Seed / demo-data command. Starts the platform, then runs the simulator in fast-forward mode against the
 * real ingestion API so the recorded history is produced by exactly the same path as live data.
 */
const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL, cfg.NODE_ENV !== 'production');
const platform = new Platform(cfg, log);
await platform.start();
const existing = (await platform.db.query<{ n: number }>('SELECT count(*)::int AS n FROM observations')).rows[0]!.n;
if (existing > 0 && !process.argv.includes('--force')) {
  log.info({ observations: existing }, 'database already contains recorded data; skipping seed (use --force or remove DATA_DIR to reseed)');
  await platform.stop();
  process.exit(0);
}
const app = await buildApp(platform);
await app.listen({ host: cfg.HOST, port: cfg.PORT });

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const simJs = join(root, 'packages/simulator/dist/cli.js');
const simTs = join(root, 'packages/simulator/src/cli.ts');
const minutes = process.env.SEED_MINUTES ?? '120';
const child = existsSync(simJs) && import.meta.url.endsWith('.js') ? spawn(process.execPath, [simJs, 'seed', '--minutes', minutes], { stdio: 'inherit', cwd: root }) : spawn(process.execPath, ['--no-experimental-strip-types', '--import', 'tsx', simTs, 'seed', '--minutes', minutes], { stdio: 'inherit', cwd: root });
const code: number = await new Promise((r) => child.on('exit', (c) => r(c ?? 1)));
if (code !== 0) {
  log.error({ code }, 'simulator seed failed');
  process.exit(code);
}
// Let background reconstruction / change-detection jobs finish.
for (let i = 0; i < 240; i++) {
  const running = (await platform.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM reconstructions WHERE status IN ('queued','running')`)).rows[0]!.n;
  if (running === 0 && platform.pool.queued === 0 && platform.pool.busy === 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const summary = (await platform.db.query('SELECT (SELECT count(*)::int FROM observations) AS observations, (SELECT count(*)::int FROM tracks) AS tracks, (SELECT count(*)::int FROM alerts) AS alerts, (SELECT count(*)::int FROM incidents) AS incidents, (SELECT count(*)::int FROM world_changes) AS changes, (SELECT count(*)::int FROM reconstructions) AS reconstructions')).rows[0];
log.info(summary, 'seed complete');
await app.close();
await platform.stop();
process.exit(0);
