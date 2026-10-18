#!/usr/bin/env node
// Builds twice from the same checkout and compares the digest of every shipped file. Equal digests mean the build is
// repeatable here. It cannot show that a different machine gives the same bytes; compare two hosts to show that.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS, collectEntries, treeDigest } from './lib/release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
const snapshot = () => collectEntries(ROOT, ARTIFACTS);

build();
const first = snapshot();
build();
const second = snapshot();

const a = new Map(first.map((e) => [e.path, e.sha256]));
const b = new Map(second.map((e) => [e.path, e.sha256]));
const differing = [...new Set([...a.keys(), ...b.keys()])].sort().filter((p) => a.get(p) !== b.get(p));
if (differing.length === 0) {
  console.log(`reproducible: ${first.length} files identical across two builds (digest ${treeDigest(first).slice(0, 16)})`);
} else {
  console.error(`not reproducible: ${differing.length} file(s) differ between builds`);
  for (const p of differing.slice(0, 50)) console.error(`  - ${p}`);
  process.exit(1);
}
