#!/usr/bin/env node
// Fails the build when the dependency tree has an advisory at or above the given level (default: moderate).
// Run by `npm run audit`, which `npm run verify` and the CI workflow both call.
import { spawnSync } from 'node:child_process';
import { gateReport } from './audit-gate-rules.mjs';

const level = process.argv[2] ?? 'moderate';
// npm audit exits non-zero whenever it finds anything, so the exit code is not read; the report is.
const run = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let report = null;
try {
  report = JSON.parse(run.stdout);
} catch {
  report = null;
}
const result = gateReport(report, level);
const counts = Object.entries(result.counts).map(([s, n]) => `${s} ${n}`).join(', ');
if (result.ok) {
  console.log(`audit gate (${level}): passed${counts ? ` (${counts})` : ''}`);
} else {
  console.error(`audit gate (${level}): failed`);
  for (const f of result.failures) console.error(`  - ${f}`);
  process.exit(1);
}
