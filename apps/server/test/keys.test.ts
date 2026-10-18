import { describe, expect, it, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { describeKeys, loadKeys } from '../src/keys/keyring.ts';

const KEY = 'ab'.repeat(32);
const ANCHOR = 'cd'.repeat(48);
const dir = mkdtempSync(join(tmpdir(), 'strata-keys-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A key file with the given contents and mode (default owner-only). */
function keyFile(name: string, text: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
}

describe('secret keys', () => {
  it('reads the storage key from the environment as 32 bytes', () => {
    const k = loadKeys({ STORAGE_ENCRYPTION_KEY: KEY }).storage;
    expect(k).toMatchObject({ source: 'environment' });
    expect(k?.bytes).toEqual(Buffer.from(KEY, 'hex'));
    expect(k?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reads a key from a file that only its owner can read', () => {
    const path = keyFile('storage.key', `${KEY}\n`);
    const k = loadKeys({ STORAGE_ENCRYPTION_KEY_FILE: path }).storage;
    expect(k?.source).toBe('file');
    expect(k?.bytes).toEqual(Buffer.from(KEY, 'hex'));
  });

  it('the configuration passes the file setting through to the loader', () => {
    const path = keyFile('config.key', KEY);
    expect(loadKeys(loadConfig({ STORAGE_ENCRYPTION_KEY_FILE: path })).storage?.source).toBe('file');
  });

  it('refuses a key file that other users can read', () => {
    if (process.platform === 'win32') return;
    const path = keyFile('open.key', KEY, 0o644);
    expect(() => loadKeys({ STORAGE_ENCRYPTION_KEY_FILE: path })).toThrow(/readable by other users/);
  });

  it('refuses a key given both directly and as a file', () => {
    const path = keyFile('both.key', KEY);
    expect(() => loadKeys({ STORAGE_ENCRYPTION_KEY: KEY, STORAGE_ENCRYPTION_KEY_FILE: path })).toThrow(/both set/);
  });

  it('refuses a storage key that is not exactly 32 bytes', () => {
    expect(() => loadKeys({ STORAGE_ENCRYPTION_KEY: 'ab'.repeat(31) })).toThrow(/at least 32 bytes/);
    expect(() => loadKeys({ STORAGE_ENCRYPTION_KEY: 'ab'.repeat(33) })).toThrow(/exactly 32 bytes/);
  });

  it('refuses an audit anchor key shorter than 32 bytes, and accepts a longer one', () => {
    expect(() => loadKeys({ AUDIT_ANCHOR_KEY: 'cd'.repeat(31) })).toThrow(/at least 32 bytes/);
    expect(loadKeys({ AUDIT_ANCHOR_KEY: ANCHOR }).auditAnchor?.bytes.length).toBe(48);
  });

  it('refuses a key that is not hex', () => {
    expect(() => loadKeys({ STORAGE_ENCRYPTION_KEY: 'zz'.repeat(32) })).toThrow(/must be hex/);
    expect(() => loadKeys({ STORAGE_ENCRYPTION_KEY: 'abc' })).toThrow(/must be hex/);
  });

  it('names the setting when a key file cannot be read, or is empty', () => {
    expect(() => loadKeys({ STORAGE_ENCRYPTION_KEY_FILE: join(dir, 'absent.key') })).toThrow(/STORAGE_ENCRYPTION_KEY_FILE .* cannot be read/);
    const empty = keyFile('empty.key', '\n');
    expect(() => loadKeys({ STORAGE_ENCRYPTION_KEY_FILE: empty })).toThrow(/is empty/);
  });

  it('treats an unset or blank value as no key', () => {
    expect(loadKeys({})).toEqual({ storage: null, auditAnchor: null });
    expect(loadKeys({ STORAGE_ENCRYPTION_KEY: '', AUDIT_ANCHOR_KEY: '   ' })).toEqual({ storage: null, auditAnchor: null });
  });

  it('describes the keys to an administrator without revealing them', () => {
    const ring = loadKeys({ STORAGE_ENCRYPTION_KEY: KEY, AUDIT_ANCHOR_KEY: ANCHOR });
    const shown = JSON.stringify(describeKeys(ring));
    expect(shown).toContain('"source":"environment"');
    expect(shown).toContain(ring.storage!.fingerprint);
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain(ANCHOR);
    expect(describeKeys(loadKeys({}))).toEqual({ storage: null, auditAnchor: null });
  });
});
