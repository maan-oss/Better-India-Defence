import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/**
 * Secret keys, each named once (STORAGE_ENCRYPTION_KEY, AUDIT_ANCHOR_KEY). A key is supplied either directly in the
 * environment, or, for a key kept in a mounted secret or a file the operator controls, by naming the file in NAME_FILE.
 * Setting both is refused: which one would win would then depend on the code's order, not on the operator's intent.
 *
 * A hardware security module or a cloud key service would be a third provider with the same single method. None is
 * included: the hardware is not present in this installation, and an unexercised provider would only look like one.
 */
export type KeySource = 'environment' | 'file';

export interface KeyProvider {
  readonly source: KeySource;
  /** The key text for `name` as this provider holds it, or null when it does not supply that key. */
  read(name: string): string | null;
}

export interface KeySpec {
  name: string;
  /** What the key protects, for error messages. */
  purpose: string;
  minBytes: number;
  /** Unset for no maximum. */
  maxBytes?: number;
}

export interface LoadedKey {
  source: KeySource;
  bytes: Buffer;
  /** The first 16 hex digits of the key's SHA-256: enough to confirm which key is loaded, not enough to recover it. */
  fingerprint: string;
}

/** The keys this installation uses. A null entry means the feature that needs it is off. */
export interface KeyRing {
  /** Encrypts stored media and camera stream addresses, and protects second-factor secrets. */
  storage: LoadedKey | null;
  /** Keys the HMAC on each audit anchor line. */
  auditAnchor: LoadedKey | null;
}

export const KEY_SPECS = {
  storage: { name: 'STORAGE_ENCRYPTION_KEY', purpose: 'encryption at rest', minBytes: 32, maxBytes: 32 },
  auditAnchor: { name: 'AUDIT_ANCHOR_KEY', purpose: 'the audit anchor HMAC', minBytes: 32 },
} as const satisfies Record<string, KeySpec>;

export class KeyError extends Error {}

const nonEmpty = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/** Keys given directly in the environment (or in the configuration built from it). */
export function environmentProvider(env: Readonly<Record<string, unknown>>): KeyProvider {
  return { source: 'environment', read: (name) => nonEmpty(env[name]) };
}

/** Keys read from the file named in NAME_FILE. The file must not be readable by anyone but its owner. */
export function fileProvider(env: Readonly<Record<string, unknown>>): KeyProvider {
  return {
    source: 'file',
    read: (name) => {
      const path = nonEmpty(env[`${name}_FILE`]);
      if (!path) return null;
      return readKeyFile(path, `${name}_FILE`);
    },
  };
}

function readKeyFile(path: string, setting: string): string {
  let mode: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new KeyError(`${setting} names ${path}, which is not a file`);
    mode = st.mode;
  } catch (e) {
    if (e instanceof KeyError) throw e;
    throw new KeyError(`${setting} names ${path}, which cannot be read`);
  }
  // Windows reports permissions too coarsely to check here; on POSIX, any group or other access is refused.
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new KeyError(`${setting} (${path}) is readable by other users; restrict it to its owner (chmod 600)`);
  }
  const text = nonEmpty(readFileSync(path, 'utf8'));
  if (text === null) throw new KeyError(`${setting} (${path}) is empty`);
  return text;
}

function parseKey(spec: KeySpec, text: string, source: KeySource): LoadedKey {
  if (!/^[0-9a-f]+$/i.test(text) || text.length % 2 !== 0) {
    throw new KeyError(`${spec.name} (from ${source === 'file' ? 'its file' : 'the environment'}) must be hex`);
  }
  const bytes = Buffer.from(text, 'hex');
  if (bytes.length < spec.minBytes) throw new KeyError(`${spec.name} must be at least ${spec.minBytes} bytes (${spec.minBytes * 2} hex digits) for ${spec.purpose}`);
  if (spec.maxBytes !== undefined && bytes.length > spec.maxBytes) throw new KeyError(`${spec.name} must be exactly ${spec.maxBytes} bytes (${spec.maxBytes * 2} hex digits) for ${spec.purpose}`);
  return { source, bytes, fingerprint: createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
}

/** One key from the providers: null when none supplies it, refused when more than one does. */
export function loadKey(spec: KeySpec, providers: readonly KeyProvider[]): LoadedKey | null {
  const found = providers.flatMap((p) => {
    const text = p.read(spec.name);
    return text === null ? [] : [{ source: p.source, text }];
  });
  if (found.length > 1) throw new KeyError(`${spec.name} and ${spec.name}_FILE are both set; set one of them`);
  const hit = found[0];
  return hit ? parseKey(spec, hit.text, hit.source) : null;
}

/** Every key the installation uses, read from a configuration object (or the process environment). */
export function loadKeys(env: Readonly<Record<string, unknown>>): KeyRing {
  const providers = [environmentProvider(env), fileProvider(env)];
  return {
    storage: loadKey(KEY_SPECS.storage, providers),
    auditAnchor: loadKey(KEY_SPECS.auditAnchor, providers),
  };
}

/** What may be shown to an administrator: where each key came from and its fingerprint. Never the key itself. */
export function describeKeys(ring: KeyRing): Record<keyof KeyRing, { source: KeySource; fingerprint: string } | null> {
  const one = (k: LoadedKey | null) => (k ? { source: k.source, fingerprint: k.fingerprint } : null);
  return { storage: one(ring.storage), auditAnchor: one(ring.auditAnchor) };
}
