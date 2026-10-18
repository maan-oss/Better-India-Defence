// Release manifests: what a build produced, digested, signed with Ed25519, and checked again later. The functions that
// take bytes and text are pure, so the tests cover them without a file system. The file walk is at the bottom.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const MANIFEST_FORMAT = 'strata-release-manifest/1';
export const MANIFEST_FILE = 'release-manifest.json';
export const SIGNATURE_FILE = 'release-manifest.sig';
export const SBOM_FILE = 'sbom.cdx.json';
// What ships: the compiled code and the web client, the pinned dependency tree, the pinned model manifest and the image
// definition. Source files are not listed; they are in version control, and the commit is the record of them.
export const ARTIFACTS = {
  dirs: ['apps/server/dist', 'apps/web/dist', 'packages/simulator/dist', 'packages/adapters/dist'],
  files: ['package-lock.json', 'models/manifest.json', 'Dockerfile', 'docker-compose.yml'],
};

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** One digest for a set of files: the same content at the same paths always gives the same value. */
export function treeDigest(entries) {
  const lines = [...entries].sort(byPath).map((e) => `${e.sha256}  ${e.path}\n`);
  return sha256Hex(lines.join(''));
}

/** The manifest text. It holds no time and no host name, so the same build always produces the same bytes. */
export function buildManifest({ version, files }) {
  return `${JSON.stringify({ format: MANIFEST_FORMAT, version, files: [...files].sort(byPath) }, null, 2)}\n`;
}

/** Reads a manifest back, refusing anything that is not one. */
export function parseManifest(text) {
  const m = JSON.parse(text);
  if (m?.format !== MANIFEST_FORMAT || typeof m.version !== 'string' || !Array.isArray(m.files)) {
    throw new Error('not a Strata release manifest');
  }
  for (const f of m.files) {
    if (typeof f.path !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.bytes)) {
      throw new Error(`malformed manifest entry: ${JSON.stringify(f)}`);
    }
    if (f.path.startsWith('/') || f.path.split('/').includes('..')) throw new Error(`path escapes the release: ${f.path}`);
  }
  return m;
}

const assertEd25519 = (key) => {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the release key must be Ed25519');
  return key;
};

export function newSigningKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicPem: publicKey, privatePem: privateKey };
}

export function signManifest(manifestText, privatePem) {
  return sign(null, Buffer.from(manifestText, 'utf8'), assertEd25519(createPrivateKey(privatePem))).toString('base64');
}

export function verifySignature(manifestText, signatureBase64, publicPem) {
  return verify(null, Buffer.from(manifestText, 'utf8'), assertEd25519(createPublicKey(publicPem)), Buffer.from(signatureBase64, 'base64'));
}

/** Every way the files on disk differ from the manifest: a missing file, or one whose content changed. */
export function checkManifest(manifest, digestOf) {
  return manifest.files.flatMap((f) => {
    const got = digestOf(f.path);
    if (got === null) return [`${f.path}: missing`];
    if (got !== f.sha256) return [`${f.path}: content differs from the signed build`];
    return [];
  });
}

/**
 * A CycloneDX document with its two non-deterministic fields fixed: the serial number comes from the lock file's
 * digest, and the timestamp from the given instant. Everything else npm wrote is kept as it is.
 */
export function normaliseSbom(sbom, { serialSeed, timestamp }) {
  const h = sha256Hex(serialSeed).slice(0, 32).split('');
  h[12] = '5';
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const hex = h.join('');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return { ...sbom, serialNumber: `urn:uuid:${uuid}`, metadata: { ...sbom.metadata, timestamp } };
}

/** Relative, forward-slash paths of every file under the given directories and files that exist, with digests. */
export function collectEntries(root, { dirs = [], files = [] }) {
  const entries = [];
  const addFile = (abs) => {
    const bytes = readFileSync(abs);
    entries.push({ path: relative(root, abs).split(sep).join('/'), sha256: sha256Hex(bytes), bytes: bytes.length });
  };
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else addFile(abs);
    }
  };
  for (const d of dirs) if (existsSync(join(root, d))) walk(join(root, d));
  for (const f of files) if (existsSync(join(root, f))) addFile(join(root, f));
  return entries.sort(byPath);
}
