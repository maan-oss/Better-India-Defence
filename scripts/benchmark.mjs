#!/usr/bin/env node
// Repeatable performance measurements against perf/budgets.json. Run after `npm run build`:
//   npm run bench                  measure and check every budget; writes perf/results.json; exits 1 when a budget is exceeded
//   BENCH_PAGE=0 npm run bench     skip the browser measurements (the bundle and API budgets still run)
// Requires `npm run build` first (the server and the web client are measured as built).
// The API and page measurements use a temporary installation seeded with a register of several thousand assets, so the
// numbers describe a large register, not the demonstration one. Nothing outside this repository is contacted.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { cpus, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const budgets = JSON.parse(readFileSync(join(root, 'perf', 'budgets.json'), 'utf8'));
const results = { measuredAt: new Date().toISOString(), node: process.version, cpus: cpus().length, bundle: {}, api: {}, page: {} };
const failures = [];
const check = (group, name, measured, limit, unit) => {
  const ok = measured <= limit;
  if (!ok) failures.push(`${group}.${name}: ${measured.toFixed(1)} ${unit} exceeds the budget of ${limit} ${unit}`);
  return { measured: Number(measured.toFixed(1)), limit, unit, ok };
};
const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

// ---- bundle -------------------------------------------------------------------------------------------------------
// The entry is the script the page itself names, not a file matched by name: the build also emits other index-* chunks.
// The initial load is the entry plus the chunks the page preloads. Everything else is loaded on demand.
const dist = join(root, 'apps', 'web', 'dist');
const assets = join(dist, 'assets');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = [...html.matchAll(/<script[^>]*\ssrc="\/assets\/([^"]+\.js)"/g)].map((m) => m[1])[0];
const preloads = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
if (!entry) throw new Error('index.html names no entry script');
const gzipOf = (f) => gzipSync(readFileSync(join(assets, f)), { level: 9 }).length;
let js = 0;
let css = 0;
for (const f of readdirSync(assets)) {
  if (f.endsWith('.js')) js += gzipOf(f);
  else if (f.endsWith('.css')) css += gzipOf(f);
}
const indexGz = gzipOf(entry);
const initialGz = [entry, ...preloads].reduce((sum, f) => sum + gzipOf(f), 0);
results.bundle = {
  indexJs: check('bundle', 'indexJsGzipKb', indexGz / 1024, budgets.bundle.indexJsGzipKb, 'KB'),
  initialJs: check('bundle', 'initialJsGzipKb', initialGz / 1024, budgets.bundle.initialJsGzipKb, 'KB'),
  allJs: check('bundle', 'allJsGzipKb', js / 1024, budgets.bundle.allJsGzipKb, 'KB'),
  css: check('bundle', 'cssGzipKb', css / 1024, budgets.bundle.cssGzipKb, 'KB'),
};

// ---- a temporary installation with a large register ---------------------------------------------------------------
const port = 4960;
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), 'strata-bench-'));
// The API is started without its simulator: the embedded database takes one request at a time, so a live ingest stream
// would queue every read behind it. The numbers below describe a quiet installation, which is what the budgets are for.
const server = spawn(process.execPath, [join(root, 'apps', 'server', 'dist', 'main.js')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'development',
    STRATA_MODE: 'demo',
    STRATA_DEMO_USERS: 'true',
    WEB_DIST: join(root, 'apps', 'web', 'dist'),
    DATA_DIR: join(dir, 'db'),
    SIM_STATE_FILE: join(dir, 'sim-state.json'),
    SIM_PORT: String(port + 1),
    SIM_URL: `http://127.0.0.1:${port + 1}`,
    STRATA_SERVICE_TOKEN: 'bench-service-token-0123456789',
    LOG_LEVEL: 'error',
  },
  stdio: 'ignore',
});
const stop = () => {
  server.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
};
process.on('exit', () => server.kill('SIGTERM'));

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${base}/api/auth/banner`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the benchmark server did not start');
}

try {
  await waitForServer();
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'analyst', password: 'strata-demo' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'content-type': 'application/json' };

  // The register: in batches of 2000, the largest a single import takes.
  const total = budgets.api.registerAssets;
  for (let start = 0; start < total; start += 2000) {
    const rows = ['tag,name,category,criticality,classification'];
    for (let i = start; i < Math.min(total, start + 2000); i++) rows.push(`BENCH-${String(i).padStart(5, '0')},Bench asset ${i},facilities,${1 + (i % 5)},UNCLASSIFIED`);
    const r = await fetch(`${base}/api/assets/import`, { method: 'POST', headers, body: JSON.stringify({ csv: rows.join('\n'), commit: true }) });
    if (!r.ok) throw new Error(`the import of the benchmark register failed: ${r.status} ${await r.text()}`);
  }
  const count = (await (await fetch(`${base}/api/assets`, { headers })).json()).length;
  results.api.registerAssets = count;

  const time = async (url, runs = 30) => {
    const xs = [];
    await fetch(`${base}${url}`, { headers }); // warm the code path once, not measured
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const r = await fetch(`${base}${url}`, { headers });
      await r.arrayBuffer();
      if (!r.ok) throw new Error(`${url} returned ${r.status}`);
      xs.push(performance.now() - t0);
    }
    return { p50: percentile(xs, 50), p95: percentile(xs, 95) };
  };
  const list = await time('/api/assets');
  results.api.assetList = { p50Ms: Number(list.p50.toFixed(1)), p95Ms: Number(list.p95.toFixed(1)), budget: check('api', 'assetListP95Ms', list.p95, budgets.api.assetListP95Ms, 'ms') };
  const detail = await time('/api/assets/GEN-1');
  results.api.assetDetail = { p50Ms: Number(detail.p50.toFixed(1)), p95Ms: Number(detail.p95.toFixed(1)), budget: check('api', 'assetDetailP95Ms', detail.p95, budgets.api.assetDetailP95Ms, 'ms') };

  // ---- pages (optional: needs a Chromium) --------------------------------------------------------------------------
  if (process.env.BENCH_PAGE !== '0') {
    const { chromium } = await import('@playwright/test');
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
    const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    try {
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      let t0 = performance.now();
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
      const signIn = performance.now() - t0;
      await page.fill('#u', 'analyst');
      await page.fill('#p', 'strata-demo');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByRole('navigation', { name: 'Application areas' }).waitFor();
      t0 = performance.now();
      await page.goto(`${base}/assets`, { waitUntil: 'domcontentloaded' });
      await page.locator('ul[aria-label="Assets"] li').first().waitFor({ timeout: 60_000 });
      const rows = performance.now() - t0;
      results.page = {
        signInDomContentLoaded: check('page', 'signInDomContentLoadedMs', signIn, budgets.page.signInDomContentLoadedMs, 'ms'),
        assetsFirstRows: check('page', 'assetsFirstRowsMs', rows, budgets.page.assetsFirstRowsMs, 'ms'),
      };
    } finally {
      await browser.close();
    }
  }
} finally {
  stop();
}

writeFileSync(join(root, 'perf', 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
for (const [group, rows] of Object.entries({ bundle: results.bundle, api: { assetList: results.api.assetList.budget, assetDetail: results.api.assetDetail.budget }, page: results.page })) {
  for (const [name, m] of Object.entries(rows ?? {})) {
    if (m && m.measured !== undefined) console.log(`${group.padEnd(7)} ${name.padEnd(26)} ${String(m.measured).padStart(8)} ${m.unit}  (budget ${m.limit} ${m.unit}) ${m.ok ? 'ok' : 'OVER'}`);
  }
}
console.log(`register: ${results.api.registerAssets} assets; list p95 ${results.api.assetList.p95Ms} ms; detail p95 ${results.api.assetDetail.p95Ms} ms`);
if (failures.length) {
  console.error(`\n${failures.length} budget(s) exceeded:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('all budgets met');
