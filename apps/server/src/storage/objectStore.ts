import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

/**
 * Object storage abstraction for media (frames, imagery, point clouds, reconstruction outputs).
 * The local implementation writes content-addressed files under DATA_DIR/objects and optionally encrypts
 * them at rest with AES-256-GCM. An S3-compatible implementation (MinIO/on-prem) would implement the same
 * interface; it is not included because no such service is part of the offline development setup.
 */
export interface StoredObject {
  key: string;
  sha256: string;
  bytes: number;
  encrypted: boolean;
}

export interface ObjectStore {
  put(prefix: string, data: Uint8Array): Promise<StoredObject>;
  get(key: string, encrypted: boolean): Promise<Uint8Array>;
  usage(): Promise<{ objects: number; bytes: number }>;
}

export class LocalObjectStore implements ObjectStore {
  private objects = 0;
  private bytes = 0;

  constructor(
    private readonly root: string,
    private readonly key: Buffer | null,
  ) {}

  private path(key: string): string {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root))) throw new Error('invalid object key');
    return p;
  }

  async put(prefix: string, data: Uint8Array): Promise<StoredObject> {
    if (!/^[a-z0-9/_-]+$/i.test(prefix)) throw new Error('invalid prefix');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const key = `${prefix}/${sha256.slice(0, 2)}/${sha256}`;
    const p = this.path(key);
    const exists = await stat(p).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await mkdir(dirname(p), { recursive: true });
      let body: Uint8Array = data;
      if (this.key) {
        const iv = randomBytes(12);
        const c = createCipheriv('aes-256-gcm', this.key, iv);
        const enc = Buffer.concat([c.update(data), c.final()]);
        body = Buffer.concat([iv, c.getAuthTag(), enc]);
      }
      await writeFile(p, body);
      this.objects++;
      this.bytes += body.byteLength;
    }
    return { key, sha256, bytes: data.byteLength, encrypted: Boolean(this.key) };
  }

  async get(key: string, encrypted: boolean): Promise<Uint8Array> {
    const raw = await readFile(this.path(key));
    if (!encrypted) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (!this.key) throw new Error('object is encrypted but no STORAGE_ENCRYPTION_KEY is configured');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    const out = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }

  async usage(): Promise<{ objects: number; bytes: number }> {
    return { objects: this.objects, bytes: this.bytes };
  }
}
