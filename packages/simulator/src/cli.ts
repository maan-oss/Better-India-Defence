#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { SimulatorEngine } from './engine.ts';
import { FailureInjector } from './failures.ts';
import { IngestClient } from './transport.ts';
import { startService } from './service.ts';
import { loadState, saveState, type SimState } from './state.ts';
import { DEFAULT_RECORDING } from './truth/scenarios.ts';
import { hms, MINUTE } from './time.ts';
import { gaussian, mulberry32, normalizeVec } from '@strata/domain';
import { T01_SIGNATURE } from './truth/entities.ts';

const env = (k: string, d: string) => process.env[k] ?? d;
const SERVER = env('STRATA_INGEST_URL', 'http://127.0.0.1:4000');
const TOKEN = env('STRATA_SERVICE_TOKEN', 'dev-service-token-change-me');
const STATE = resolve(env('SIM_STATE_FILE', 'data/sim-state.json'));
const PORT = Number(env('SIM_PORT', '4100'));

const log = (m: string) => process.stdout.write(`[sim ${new Date().toISOString().slice(11, 19)}] ${m}\n`);

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${SERVER}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`ingestion API at ${SERVER} not reachable`);
}

/** Fast-forward a recorded history through the real ingestion API. */
async function seed(): Promise<void> {
  const minutes = Number(arg('minutes', env('SEED_MINUTES', '120')));
  const end = Math.floor(Date.now() / 1000) * 1000;
  const start = end - minutes * MINUTE;
  const state: SimState = {
    version: 1,
    recordingStart: start,
    recordingEnd: end,
    schedule: DEFAULT_RECORDING.filter((r) => r.offsetMin < minutes).map((r) => ({ id: `rec-${r.key}`, key: r.key, t0: start + r.offsetMin * MINUTE, source: 'recording' as const })),
  };
  saveState(STATE, state);
  await waitForServer();
  const engine = new SimulatorEngine(state.schedule);
  const client = new IngestClient(SERVER, TOKEN, 1_000_000, log);
  log(`seeding ${minutes} min of recorded history ${hms(start)} → ${hms(end)} UTC via ${SERVER}`);
  const t0 = Date.now();
  let lastLog = 0;
  // Catch up to real time: the recording ends when the fast-forward reaches the present, so live operation
  // continues without a gap.
  let t = start;
  for (; t <= Math.floor(Date.now() / 1000) * 1000 - 1000; t += 1000) {
    const out = engine.step(t);
    if (out.media.length) {
      await client.flush(2500);
      for (const m of out.media) await client.uploadMedia(m);
    }
    client.enqueue(out.messages);
    if (client.queued >= 2500) await client.flush(2500);
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      log(`  ${hms(t)}  ${(((t - start) / (end - start)) * 100).toFixed(0)}%  sent=${client.sent} media=${engine.stats.media}`);
    }
  }
  while (client.queued) await client.flush(2500);
  state.recordingEnd = t - 1000;
  saveState(STATE, state);
  await enrollTestSubject();
  log(`seed complete: ${client.sent} messages, ${engine.stats.media} media assets in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

/**
 * Test-harness enrolment of the consenting synthetic test subject T-01. Mirrors a controlled enrolment
 * capture: a high-quality descriptor taken at a registration point, slightly different from any later
 * operational observation. The platform never sees simulator truth beyond this explicit enrolment record.
 */
async function enrollTestSubject(): Promise<void> {
  const rng = mulberry32(4242);
  const descriptor = normalizeVec(T01_SIGNATURE.map((v) => v + 0.05 * gaussian(rng))).map((v) => Math.round(v * 10000) / 10000);
  const res = await fetch(`${SERVER}/api/handoff/subjects`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'subject-t01', label: 'TEST SUBJECT T-01 (synthetic)', consentRef: 'SYNTHETIC-CONSENT-0001 (generated test identity)', synthetic: true, descriptor, notes: 'Synthetic identity used for multi-camera hand-off demonstration only.' }),
  });
  log(`test subject enrolment: HTTP ${res.status}`);
}

/** Real-time operation: one step per wall-clock second, plus the VMS/control service. */
async function live(): Promise<void> {
  const state = loadState(STATE);
  const engine = new SimulatorEngine(state.schedule);
  const client = new IngestClient(SERVER, TOKEN, 250_000, log);
  const failures = new FailureInjector();
  let liveEdge = Math.max(state.recordingEnd ?? 0, Math.floor(Date.now() / 1000) * 1000 - 300_000);
  startService(PORT, { engine, failures, client, state, token: TOKEN, persist: () => saveState(STATE, state), liveEdge: () => liveEdge, log });
  await waitForServer().catch((e: unknown) => log(String(e)));
  log(`live simulation started; ${state.schedule.length} scheduled scenario(s) loaded`);
  const tick = async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    // Never run ahead of wall-clock. After a pause, buffered data is delivered late (store-and-forward),
    // bounded to 5 minutes; anything older is a genuine gap.
    let t = Math.max(liveEdge + 1000, now - 300_000);
    for (; t <= now; t += 1000) {
      const out = engine.step(t);
      for (const m of out.media) await client.uploadMedia(m).catch((e: unknown) => log(String(e)));
      const items = failures.apply(out.messages, t);
      if (failures.config.latencyMs > 0) {
        const delay = failures.config.latencyMs;
        setTimeout(() => client.enqueue(items), delay);
      } else client.enqueue(items);
      liveEdge = t;
    }
    await client.flush(2000, failures.config.disconnectedUntil);
  };
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      log(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setTimeout(() => void loop(), 1000 - (Date.now() % 1000) + 20);
  };
  void loop();
}

const cmd = process.argv[2] ?? 'live';
if (cmd === 'seed') seed().catch((e: unknown) => {
  log(`seed failed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
else if (cmd === 'live') void live();
else {
  log(`unknown command ${cmd}; use "seed" or "live"`);
  process.exit(2);
}
