#!/usr/bin/env node
/**
 * Downloads the vision models listed in models/manifest.json into STRATA_MODELS_DIR (default ./models) and
 * verifies their SHA-256. For air-gapped sites: run this on a connected machine, then copy the folder
 * (the server verifies hashes again at load time).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'models/manifest.json'), 'utf8'));
const dir = resolve(root, process.env.STRATA_MODELS_DIR ?? 'models');
mkdirSync(dir, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
let failed = 0;
for (const m of manifest.models) {
  const file = resolve(dir, m.file);
  if (existsSync(file) && sha(readFileSync(file)) === m.sha256) {
    console.log(`ok       ${m.file}`);
    continue;
  }
  process.stdout.write(`fetching ${m.file} … `);
  try {
    const res = await fetch(m.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const h = sha(buf);
    if (h !== m.sha256) throw new Error(`hash mismatch (got ${h})`);
    writeFileSync(file, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)} MB verified`);
  } catch (e) {
    failed++;
    console.log(`FAILED: ${e instanceof Error ? e.message : e}`);
  }
}
if (failed) {
  console.error(`${failed} model(s) missing. Vision features that need them will report "model not installed".`);
  process.exit(1);
}
