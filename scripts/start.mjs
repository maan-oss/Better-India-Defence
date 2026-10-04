#!/usr/bin/env node
/**
 * Production entry point: `npm run build && npm start`.
 *  - runs the bundled API server (apps/server/dist), which also serves the built web client (apps/web/dist)
 *  - unless STRATA_SIMULATOR=false, seeds recorded history on first run and starts the live simulator
 *    (the simulator is the synthetic data source for this test facility; real deployments replace it with
 *    sensor adapters that POST to /api/ingest)
 *
 * NODE_ENV defaults to "production", which refuses to start with development secrets. See .env.example.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
loadEnv(resolve(root, '.env'));
const env = { ...process.env };
env.NODE_ENV ??= 'production';
env.WEB_DIST ??= resolve(root, 'apps/web/dist');
const scheme = env.TLS_CERT_FILE ? 'https' : 'http';
const API = `${scheme}://${env.HOST ?? '127.0.0.1'}:${env.PORT ?? '4000'}`;
env.STRATA_INGEST_URL ??= API;

const serverJs = resolve(root, 'apps/server/dist/main.js');
const simJs = resolve(root, 'packages/simulator/dist/cli.js');
for (const f of [serverJs, simJs, resolve(env.WEB_DIST, 'index.html')]) {
  if (!existsSync(f)) {
    console.error(`Missing build output: ${f}\nRun "npm run build" first.`);
    process.exit(1);
  }
}

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

const procs = [];
function run(name, args) {
  const p = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] });
  procs.push(p);
  return p;
}
function shutdown(code = 0) {
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

async function waitFor(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const api = run('api', [serverJs]);
api.on('exit', (c) => {
  console.error(`API exited (${c})`);
  shutdown(c ?? 1);
});
if (!(await waitFor(`${API}/api/health`))) {
  console.error('API failed to become healthy');
  shutdown(1);
} else if (env.STRATA_SIMULATOR !== 'false') {
  const stateFile = resolve(root, env.SIM_STATE_FILE ?? 'data/sim-state.json');
  if (!existsSync(stateFile)) {
    console.log('First run: recording synthetic scenario history…');
    const seed = run('seed', [simJs, 'seed', '--minutes', env.SEED_MINUTES ?? '120']);
    const code = await new Promise((r) => seed.on('exit', r));
    if (code !== 0) console.error('seed failed; continuing with live data only');
  }
  run('sim', [simJs, 'live']);
  console.log(`\n  Strata is running — open ${API}\n`);
} else {
  console.log(`\n  Strata is running (simulator disabled) — ${API}\n`);
}
