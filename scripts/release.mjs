#!/usr/bin/env node
// Signed release manifests for the build outputs.
//   node scripts/release.mjs keygen <private.pem> <public.pem>   new Ed25519 key pair (private key written mode 0600)
//   node scripts/release.mjs sign [outDir]    manifest, SBOM and signature; key from STRATA_RELEASE_KEY_FILE or STRATA_RELEASE_KEY
//   node scripts/release.mjs verify [outDir]  check the signature and every digest; key from STRATA_RELEASE_PUBLIC_KEY_FILE or STRATA_RELEASE_PUBLIC_KEY
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACTS, MANIFEST_FILE, SBOM_FILE, SIGNATURE_FILE, buildManifest, checkManifest, collectEntries, newSigningKeys,
  normaliseSbom, parseManifest, sha256Hex, signManifest, verifySignature,
} from './lib/release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = (name) => process.env[name] ?? null;
const keyFrom = (fileVar, pemVar, what) => {
  const file = env(fileVar);
  const pem = file ? readFileSync(file, 'utf8') : env(pemVar);
  if (!pem) throw new Error(`no ${what}: set ${fileVar} or ${pemVar}`);
  return pem;
};

function sbomFor(lockBytes) {
  const raw = JSON.parse(execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  if (raw.bomFormat !== 'CycloneDX') throw new Error('npm sbom did not produce a CycloneDX document');
  // The timestamp is the commit's, so rebuilding the same commit gives the same document.
  const commitTime = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const timestamp = env('SOURCE_DATE_EPOCH') ? new Date(Number(env('SOURCE_DATE_EPOCH')) * 1000).toISOString() : commitTime;
  return `${JSON.stringify(normaliseSbom(raw, { serialSeed: sha256Hex(lockBytes), timestamp }), null, 2)}\n`;
}

function sign(outDir) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const entries = collectEntries(ROOT, ARTIFACTS);
  const sbom = sbomFor(readFileSync(join(ROOT, 'package-lock.json')));
  const sbomEntry = { path: SBOM_FILE, sha256: sha256Hex(sbom), bytes: Buffer.byteLength(sbom) };
  const manifest = buildManifest({ version, files: [...entries, sbomEntry] });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, SBOM_FILE), sbom);
  writeFileSync(join(outDir, MANIFEST_FILE), manifest);
  writeFileSync(join(outDir, SIGNATURE_FILE), `${signManifest(manifest, keyFrom('STRATA_RELEASE_KEY_FILE', 'STRATA_RELEASE_KEY', 'release signing key'))}\n`);
  console.log(`signed ${entries.length + 1} files into ${outDir} (version ${version}, manifest ${sha256Hex(manifest).slice(0, 16)})`);
}

function verify(outDir) {
  const manifestText = readFileSync(join(outDir, MANIFEST_FILE), 'utf8');
  const signature = readFileSync(join(outDir, SIGNATURE_FILE), 'utf8').trim();
  const publicPem = keyFrom('STRATA_RELEASE_PUBLIC_KEY_FILE', 'STRATA_RELEASE_PUBLIC_KEY', 'release public key');
  if (!verifySignature(manifestText, signature, publicPem)) throw new Error('the manifest signature does not verify');
  const manifest = parseManifest(manifestText);
  const problems = checkManifest(manifest, (path) => {
    const inOutDir = path === SBOM_FILE;
    try {
      const bytes = readFileSync(inOutDir ? join(outDir, path) : join(ROOT, path));
      return sha256Hex(bytes);
    } catch {
      return null;
    }
  });
  if (problems.length) {
    console.error(`release verification failed (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`release ${manifest.version} verified: signature valid, ${manifest.files.length} files match`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'keygen') {
  const [priv, pub] = args;
  if (!priv || !pub) throw new Error('usage: keygen <private.pem> <public.pem>');
  const { privatePem, publicPem } = newSigningKeys();
  writeFileSync(priv, privatePem, { mode: 0o600, flag: 'wx' });
  writeFileSync(pub, publicPem, { flag: 'wx' });
  console.log(`wrote ${priv} (keep it secret) and ${pub}`);
} else if (cmd === 'sign') sign(resolve(args[0] ?? join(ROOT, 'release')));
else if (cmd === 'verify') verify(resolve(args[0] ?? join(ROOT, 'release')));
else {
  console.error('usage: release.mjs keygen|sign|verify [args]');
  process.exit(2);
}
