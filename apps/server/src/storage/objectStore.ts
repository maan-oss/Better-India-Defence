import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
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
  /** Run `fn` with a plain local file for the object (decrypted to a temporary file when encrypted). */
  withLocalFile<T>(key: string, encrypted: boolean, fn: (path: string) => Promise<T>): Promise<T>;
  /** Stream an upload to storage without buffering it in memory. Rejects once `maxBytes` is exceeded. */
  putStream(prefix: string, input: Readable, maxBytes: number): Promise<StoredObject & { head: Uint8Array }>;
  remove(key: string): Promise<void>;
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

  async putStream(prefix: string, input: Readable, maxBytes: number): Promise<StoredObject & { head: Uint8Array }> {
    if (!/^[a-z0-9/_-]+$/i.test(prefix)) throw new Error('invalid prefix');
    const tmpDir = join(this.root, '..', 'tmp');
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const tmp = join(tmpDir, randomBytes(12).toString('hex'));
    const hash = createHash('sha256');
    const iv = randomBytes(12);
    const cipher = this.key ? createCipheriv('aes-256-gcm', this.key, iv) : null;
    const out = createWriteStream(tmp, { mode: 0o600 });
    const write = (b: Uint8Array) => new Promise<void>((res, rej) => (out.write(b, (e) => (e ? rej(e) : res())) ? undefined : undefined));
    let bytes = 0;
    const head: number[] = [];
    try {
      if (cipher) await write(Buffer.concat([iv, Buffer.alloc(16)])); // tag patched in after finalising
      for await (const chunk of input as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error(`upload exceeds ${maxBytes} bytes`);
        if (head.length < 64) head.push(...chunk.subarray(0, 64 - head.length));
        hash.update(chunk);
        await write(cipher ? cipher.update(chunk) : chunk);
      }
      if (cipher) await write(cipher.final());
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
      if (cipher) {
        const fh = await open(tmp, 'r+');
        await fh.write(cipher.getAuthTag(), 0, 16, 12);
        await fh.close();
      }
      const sha256 = hash.digest('hex');
      const key = `${prefix}/${sha256.slice(0, 2)}/${sha256}`;
      const p = this.path(key);
      await mkdir(dirname(p), { recursive: true });
      const exists = await stat(p).then(
        () => true,
        () => false,
      );
      if (exists) await rm(tmp, { force: true });
      else {
        await rename(tmp, p);
        this.objects++;
        this.bytes += bytes;
      }
      return { key, sha256, bytes, encrypted: Boolean(this.key), head: Uint8Array.from(head) };
    } catch (e) {
      out.destroy();
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async withLocalFile<T>(key: string, encrypted: boolean, fn: (path: string) => Promise<T>): Promise<T> {
    if (!encrypted) return fn(this.path(key));
    const tmpDir = join(this.root, '..', 'tmp');
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const tmp = join(tmpDir, randomBytes(12).toString('hex'));
    await writeFile(tmp, await this.get(key, true), { mode: 0o600 });
    try {
      return await fn(tmp);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async usage(): Promise<{ objects: number; bytes: number }> {
    return { objects: this.objects, bytes: this.bytes };
  }
}
