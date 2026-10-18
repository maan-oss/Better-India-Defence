import { hmacSha1 } from './sha1.ts';

/**
 * One-time passwords: HOTP (RFC 4226) and TOTP (RFC 6238) with HMAC-SHA-1, the algorithm authenticator apps use.
 * Pure and synchronous, so the server and the browser share the rules. The server supplies the clock and stores the last
 * accepted step, so a code cannot be used twice.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('not base32');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** The HOTP value for a counter, as a zero-padded decimal string. */
export function hotp(secret: Uint8Array, counter: number, digits = 6): string {
  const msg = new Uint8Array(8);
  const view = new DataView(msg.buffer);
  // The counter is 64 bits; JavaScript numbers are exact to 2^53, far beyond any time step.
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const mac = hmacSha1(secret, msg);
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

export const TOTP_STEP_SECONDS = 30;

/** The time step (30 seconds since the Unix epoch) that a clock reading falls in. */
export const stepOf = (epochMs: number, stepSeconds = TOTP_STEP_SECONDS) => Math.floor(epochMs / 1000 / stepSeconds);

export function totp(secret: Uint8Array, epochMs: number, digits = 6): string {
  return hotp(secret, stepOf(epochMs), digits);
}

export interface TotpCheck {
  ok: boolean;
  /** The step the code matched; the server stores it as the last accepted step. */
  step: number | null;
}

/** Equal-length strings compared without stopping at the first difference. */
const sameText = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Checks a code against the steps around the clock reading. A code is accepted once: steps at or before `lastStep` are
 * refused, so a code seen in transit cannot be replayed within its window. `window` is how many steps either side count.
 */
export function verifyTotp(secret: Uint8Array, code: string, epochMs: number, lastStep: number, { digits = 6, window = 1 } = {}): TotpCheck {
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return { ok: false, step: null };
  const now = stepOf(epochMs);
  for (let s = now - window; s <= now + window; s++) {
    if (s <= lastStep) continue;
    if (sameText(hotp(secret, s, digits), code)) return { ok: true, step: s };
  }
  return { ok: false, step: null };
}

/** The address an authenticator app reads from a QR code: account name, issuer and the secret in base32. */
export function otpauthUri(issuer: string, account: string, secret: Uint8Array, digits = 6): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: String(digits), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
