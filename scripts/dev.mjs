#!/usr/bin/env node
/**
 * Single development entry point: `npm run dev`.
 *  1. starts the API server (embedded PostgreSQL unless DATABASE_URL is set)
 *  2. seeds 2 h of recorded scenario history through the ingestion API on first run
 *  3. starts the live simulator (sensor adapters + synthetic VMS)
 *  4. starts the web client (Vite) — open http://127.0.0.1:5173
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
loadEnv(resolve(root, '.env'));
const env = { ...process.env };
const API = `http://${env.HOST ?? '127.0.0.1'}:${env.PORT ?? '4000'}`;
env.STRATA_INGEST_URL ??= API;
const procs = [];
const colors = { api: 36, sim: 33, web: 35, seed: 32 };

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

function run(name, args, cwd = root) {
  const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${colors[name] ?? 37}m${name.padEnd(4)}\x1b[0m │ `;
  const pipe = (s) => s.toString().split('\n').filter(Boolean).forEach((l) => process.stdout.write(prefix + l + '\n'));
  p.stdout.on('data', pipe);
  p.stderr.on('data', pipe);
  procs.push(p);
  return p;
}

const tsx = ['--no-experimental-strip-types', '--import', 'tsx'];

async function waitFor(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function shutdown() {
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function startApi() {
  const api = run('api', [...tsx, 'apps/server/src/main.ts']);
  api.on('exit', (c) => {
    if (c === 75) {
      console.log('API restarting to apply configuration…');
      procs.splice(procs.indexOf(api), 1);
      startApi();
      return;
    }
    console.error(`API exited (${c})`);
    shutdown();
  });
}
startApi();
if (!(await waitFor(`${API}/api/health`))) {
  console.error('API failed to start');
  shutdown();
}
// The simulator drives only the demo site; a configured real site gets its data from real sensors.
const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => ({ simulated: true }));
if (health.simulated === false) {
  console.log(health.needsSetup ? 'Operational mode, first run: open the console and enter the setup code from the api log.' : `Site "${health.site}": real sensors only (simulator runs only with STRATA_MODE=demo).`);
  run('web', [resolve(root, 'node_modules/vite/bin/vite.js')], resolve(root, 'apps/web'));
  console.log('\n  Strata is starting — open \x1b[1mhttp://127.0.0.1:5173\x1b[0m\n');
} else {
// Seed on first run: the simulator fast-forwards recorded history through the live API.
const stateFile = resolve(root, env.SIM_STATE_FILE ?? 'data/sim-state.json');
if (!existsSync(stateFile)) {
  console.log('First run: recording synthetic scenario history (≈1–2 min)…');
  const seed = run('seed', [...tsx, 'packages/simulator/src/cli.ts', 'seed', '--minutes', env.SEED_MINUTES ?? '120']);
  const code = await new Promise((r) => seed.on('exit', r));
  if (code !== 0) console.error('seed failed; continuing with live data only');
}
run('sim', [...tsx, 'packages/simulator/src/cli.ts', 'live']);
run('web', [resolve(root, 'node_modules/vite/bin/vite.js')], resolve(root, 'apps/web'));
console.log('\n  Strata is starting — open \x1b[1mhttp://127.0.0.1:5173\x1b[0m\n');
}
