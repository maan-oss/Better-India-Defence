import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildManifest, checkManifest, collectEntries, newSigningKeys, normaliseSbom, parseManifest, sha256Hex,
  signManifest, treeDigest, verifySignature,
} from '../lib/release.mjs';

const dir = mkdtempSync(join(tmpdir(), 'strata-release-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry = (path, text) => ({ path, sha256: sha256Hex(Buffer.from(text)), bytes: Buffer.byteLength(text) });

describe('release signature', () => {
  const keys = newSigningKeys();
  const files = [entry('apps/web/dist/index.html', '<html></html>'), entry('package-lock.json', '{}')];
  const manifest = buildManifest({ version: '0.1.0', files });

  it('verifies with the matching public key', () => {
    const sig = signManifest(manifest, keys.privatePem);
    expect(verifySignature(manifest, sig, keys.publicPem)).toBe(true);
  });

  it('refuses a manifest changed after signing, and a signature from another key', () => {
    const sig = signManifest(manifest, keys.privatePem);
    expect(verifySignature(manifest.replace('0.1.0', '0.1.1'), sig, keys.publicPem)).toBe(false);
    const other = newSigningKeys();
    expect(verifySignature(manifest, sig, other.publicPem)).toBe(false);
  });

  it('refuses a key that is not Ed25519', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    expect(() => signManifest(manifest, rsa.privateKey)).toThrow(/Ed25519/);
  });
});

describe('release manifest', () => {
  it('is the same text whatever order the files were listed in', () => {
    const a = [entry('b.js', 'b'), entry('a.js', 'a')];
    expect(buildManifest({ version: '1', files: a })).toBe(buildManifest({ version: '1', files: [...a].reverse() }));
  });

  it('round-trips and refuses anything that is not a manifest', () => {
    const m = parseManifest(buildManifest({ version: '1', files: [entry('a.js', 'a')] }));
    expect(m.files[0].path).toBe('a.js');
    expect(() => parseManifest('{"format":"other"}')).toThrow(/not a Strata release manifest/);
    expect(() => parseManifest(JSON.stringify({ format: 'strata-release-manifest/1', version: '1', files: [{ path: '../x', sha256: 'a'.repeat(64), bytes: 1 }] }))).toThrow(/malformed|escapes/);
  });

  it('reports every missing file and every changed file', () => {
    const m = parseManifest(buildManifest({ version: '1', files: [entry('keep.js', 'k'), entry('changed.js', 'old'), entry('gone.js', 'g')] }));
    const disk = new Map([['keep.js', sha256Hex(Buffer.from('k'))], ['changed.js', sha256Hex(Buffer.from('new'))]]);
    expect(checkManifest(m, (p) => disk.get(p) ?? null)).toEqual(['changed.js: content differs from the signed build', 'gone.js: missing']);
  });
});

describe('tree digest', () => {
  it('depends on content and on path, not on the order of the list', () => {
    const x = [entry('a', '1'), entry('b', '2')];
    expect(treeDigest(x)).toBe(treeDigest([...x].reverse()));
    expect(treeDigest([entry('a', '1'), entry('c', '2')])).not.toBe(treeDigest(x));
    expect(treeDigest([entry('a', '1'), entry('b', '3')])).not.toBe(treeDigest(x));
  });
});

describe('normalised SBOM', () => {
  const raw = { bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: 'urn:uuid:random', metadata: { timestamp: 'now', tools: [] }, components: [{ name: 'x' }] };

  it('fixes the serial number and the timestamp, and keeps the components', () => {
    const a = normaliseSbom(raw, { serialSeed: 'lock-1', timestamp: '2026-01-01T00:00:00.000Z' });
    const b = normaliseSbom({ ...raw, serialNumber: 'urn:uuid:other', metadata: { timestamp: 'later', tools: [] } }, { serialSeed: 'lock-1', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.components).toEqual(raw.components);
    expect(normaliseSbom(raw, { serialSeed: 'lock-2', timestamp: '2026-01-01T00:00:00.000Z' }).serialNumber).not.toBe(a.serialNumber);
  });
});

describe('collecting files', () => {
  it('lists files with relative forward-slash paths, skipping what does not exist', () => {
    const root = join(dir, 'tree');
    mkdirSync(join(root, 'out', 'nested'), { recursive: true });
    writeFileSync(join(root, 'out', 'nested', 'b.js'), 'b');
    writeFileSync(join(root, 'out', 'a.js'), 'a');
    writeFileSync(join(root, 'top.json'), '{}');
    const entries = collectEntries(root, { dirs: ['out', 'absent'], files: ['top.json', 'absent.json'] });
    expect(entries.map((e) => e.path)).toEqual(['out/a.js', 'out/nested/b.js', 'top.json']);
    expect(entries[0].bytes).toBe(1);
  });
});
