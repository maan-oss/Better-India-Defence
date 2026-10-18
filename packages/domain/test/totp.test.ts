import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUri, stepOf, totp, verifyTotp } from '../src/auth/totp.ts';
import { hmacSha1, sha1 } from '../src/auth/sha1.ts';

/** RFC 4226 Appendix D (HOTP) and RFC 6238 Appendix B (TOTP, SHA-1) test vectors. */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('HOTP (RFC 4226 Appendix D)', () => {
  it('matches the published values for counters 0 to 9', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });
});

describe('TOTP (RFC 6238 Appendix B, SHA-1, 8 digits)', () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  it.each(vectors)('at %i seconds gives %s', (seconds, code) => {
    expect(totp(RFC_SECRET, seconds * 1000, 8)).toBe(code);
  });
});

describe('verifying a code', () => {
  const at = 59_000; // step 1
  it('accepts the current code and the neighbours within the window, and reports the step', () => {
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, stepOf(at)), at, 0)).toEqual({ ok: true, step: 1 });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, 0), at, -1)).toEqual({ ok: true, step: 0 });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, 2), at, 0).ok).toBe(true);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, 3), at, 0).ok).toBe(false);
  });

  it('refuses a code that was already accepted: a step at or before the last accepted one', () => {
    const code = hotp(RFC_SECRET, 1);
    expect(verifyTotp(RFC_SECRET, code, at, 1).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, code, at, 0).ok).toBe(true);
  });

  it('refuses malformed codes without comparing them', () => {
    expect(verifyTotp(RFC_SECRET, '12345', at, 0).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, 'abcdef', at, 0).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, '1234567', at, 0).ok).toBe(false);
  });
});

describe('base32 and the authenticator address', () => {
  it('round-trips and matches the RFC 4648 example', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(new TextDecoder().decode(base32Decode('MZXW6YTBOI'))).toBe('foobar');
    expect(Buffer.from(base32Decode(base32Encode(RFC_SECRET)))).toEqual(RFC_SECRET);
  });

  it('builds a standard otpauth address with the secret, issuer, algorithm, digits and period', () => {
    const uri = otpauthUri('Strata', 'analyst', Buffer.from('foobar'));
    const url = new URL(uri);
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname.slice(1))).toBe('Strata:analyst');
    expect(url.searchParams.get('secret')).toBe('MZXW6YTBOI');
    expect(url.searchParams.get('issuer')).toBe('Strata');
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });
});

describe('SHA-1 and HMAC-SHA-1 (RFC 3174, RFC 2202)', () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  it('hashes the published test strings', () => {
    expect(hex(sha1(new TextEncoder().encode('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(hex(sha1(new Uint8Array(0)))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(hex(sha1(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1');
  });
  it('computes HMAC-SHA-1 for the RFC 2202 vectors, including a key longer than a block', () => {
    expect(hex(hmacSha1(new Uint8Array(20).fill(0x0b), new TextEncoder().encode('Hi There')))).toBe('b617318655057264e28bc0b6fb378c8ef146be00');
    expect(hex(hmacSha1(new TextEncoder().encode('Jefe'), new TextEncoder().encode('what do ya want for nothing?')))).toBe('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
    expect(hex(hmacSha1(new Uint8Array(80).fill(0xaa), new TextEncoder().encode('Test Using Larger Than Block-Size Key - Hash Key First')))).toBe('aa4ae5e15272d00e95705637ce8a3b55ed402112');
  });
});
