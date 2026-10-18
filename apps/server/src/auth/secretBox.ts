import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Seals a secret with AES-256-GCM under the storage key, for values that must be readable by the server but not by
 * anyone who reads the database: second-factor secrets. Output is base64 of iv (12 bytes) | tag (16) | ciphertext.
 */
export function sealSecret(key: Buffer, plain: Buffer): string {
  if (key.length !== 32) throw new Error('the storage key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** Throws if the value was altered or sealed under another key. */
export function openSecret(key: Buffer, sealed: string): Buffer {
  const raw = Buffer.from(sealed, 'base64');
  if (raw.length < 29) throw new Error('sealed secret is malformed');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}
