import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';
import { mappedRole, pkceChallenge, verifyIdToken, type Jwk } from '../src/auth/oidc.ts';

/**
 * Sign-in with an identity provider. The first block checks the token rules on their own. The second runs the whole
 * authorization-code flow against a local mock provider: discovery, PKCE, a signed ID token, and the callback.
 */
const KID = 'test-key-1';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk: Jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: KID, alg: 'RS256', use: 'sig' } as Jwk;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload: Record<string, unknown>, key: KeyObject = privateKey, header: Record<string, unknown> = { alg: 'RS256', kid: KID, typ: 'JWT' }) {
  const h = b64(header);
  const p = b64(payload);
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url');
  return `${h}.${p}.${s}`;
}
const NOW = Date.now();
const claims = (over: Record<string, unknown> = {}) => ({
  iss: 'https://idp.example.mil',
  aud: 'strata',
  sub: 'user-123',
  nonce: 'n-1',
  iat: Math.floor(NOW / 1000),
  exp: Math.floor(NOW / 1000) + 300,
  ...over,
});
const opts = { issuer: 'https://idp.example.mil', audience: 'strata', nonce: 'n-1', now: NOW };

describe('ID token checks', () => {
  it('accepts a correctly signed token for this issuer, client and nonce', () => {
    expect(verifyIdToken(sign(claims()), [jwk], opts)).toMatchObject({ sub: 'user-123' });
  });

  it('refuses a signature made with another key, and an unknown key id', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(() => verifyIdToken(sign(claims(), other), [jwk], opts)).toThrow(/signature/);
    expect(() => verifyIdToken(sign(claims(), privateKey, { alg: 'RS256', kid: 'other' }), [jwk], opts)).toThrow(/no published key/);
  });

  it('refuses tokens that are not RS256: "none", and an HMAC keyed with the public key', () => {
    const body = `${b64({ alg: 'none' })}.${b64(claims())}.`;
    expect(() => verifyIdToken(body, [jwk], opts)).toThrow(/only RS256/);
    const hs = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims())}.${createHash('sha256').update('x').digest('base64url')}`;
    expect(() => verifyIdToken(hs, [jwk], opts)).toThrow(/only RS256/);
  });

  it('refuses another issuer, another client, an expired token, a future token and a wrong nonce', () => {
    expect(() => verifyIdToken(sign(claims({ iss: 'https://evil.example' })), [jwk], opts)).toThrow(/another issuer/);
    expect(() => verifyIdToken(sign(claims({ aud: 'other-app' })), [jwk], opts)).toThrow(/another client/);
    expect(() => verifyIdToken(sign(claims({ exp: Math.floor(NOW / 1000) - 3600 })), [jwk], opts)).toThrow(/expired/);
    expect(() => verifyIdToken(sign(claims({ iat: Math.floor(NOW / 1000) + 3600 })), [jwk], opts)).toThrow(/future/);
    expect(() => verifyIdToken(sign(claims({ nonce: 'n-2' })), [jwk], opts)).toThrow(/nonce/);
  });

  it('requires azp when there are several audiences, and refuses a token with no subject', () => {
    expect(() => verifyIdToken(sign(claims({ aud: ['strata', 'other'] })), [jwk], opts)).toThrow(/several audiences/);
    expect(verifyIdToken(sign(claims({ aud: ['strata', 'other'], azp: 'strata' })), [jwk], opts)).toBeTruthy();
    expect(() => verifyIdToken(sign(claims({ sub: '' })), [jwk], opts)).toThrow(/no subject/);
  });

  it('a tampered payload fails the signature', () => {
    const [h, , s] = sign(claims()).split('.');
    const forged = `${h}.${b64(claims({ sub: 'admin' }))}.${s}`;
    expect(() => verifyIdToken(forged, [jwk], opts)).toThrow(/signature/);
  });
});

describe('role mapping', () => {
  const map = { 'strata-viewers': 'viewer', 'strata-analysts': 'analyst', 'strata-admins': 'administrator' } as const;
  it('takes the most privileged role any group maps to', () => {
    expect(mappedRole(['strata-viewers', 'strata-admins', 'other'], map)).toBe('administrator');
    expect(mappedRole(['strata-analysts'], map)).toBe('analyst');
  });
  it('is null when no group maps, and accepts a single value', () => {
    expect(mappedRole(['unrelated'], map)).toBeNull();
    expect(mappedRole(undefined, map)).toBeNull();
    expect(mappedRole('strata-viewers', map)).toBe('viewer');
  });
});

describe('the authorization-code flow against a mock provider', () => {
  let mock: Server;
  let base: string;
  let dir: string;
  let platform: Platform;
  let app: FastifyInstance;
  /** What the mock puts in the next ID token. Tests change it between sign-ins. */
  let profile: Record<string, unknown> = {};
  let nonceOverride: string | null = null;
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string; state: string }>();
  const REDIRECT = 'https://strata.test/api/auth/oidc/callback';

  beforeAll(async () => {
    mock = createServer((req, res) => {
      const url = new URL(req.url!, base);
      const json = (o: unknown, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` });
      }
      if (url.pathname === '/jwks') return json({ keys: [jwk] });
      if (url.pathname === '/authorize') {
        const code = randomBytes(16).toString('hex');
        const state = url.searchParams.get('state')!;
        codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, redirect: url.searchParams.get('redirect_uri')!, state });
        res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${state}` });
        return res.end();
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          const entry = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          if (!entry) return json({ error: 'invalid_grant' }, 400);
          if (pkceChallenge(form.get('code_verifier') ?? '') !== entry.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE' }, 400);
          const idToken = sign({ iss: base, aud: 'strata', sub: 'mock-subject', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce: nonceOverride ?? entry.nonce, ...profile });
          return json({ id_token: idToken, token_type: 'Bearer' });
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

    dir = mkdtempSync(join(tmpdir(), 'strata-oidc-'));
    const cfg = loadConfig({
      NODE_ENV: 'test',
      STRATA_MODE: 'operational',
      STRATA_MFA_REQUIRED: 'true',
      DATA_DIR: dir,
      OIDC_ISSUER: base,
      OIDC_CLIENT_ID: 'strata',
      OIDC_CLIENT_SECRET: 'client-secret-for-tests',
      OIDC_REDIRECT_URI: REDIRECT,
      OIDC_ROLE_MAP: JSON.stringify({ 'strata-viewers': 'viewer', 'strata-analysts': 'analyst', 'strata-admins': 'administrator' }),
      OIDC_INSECURE_HTTP: 'true',
      OIDC_NAME: 'Test IdP',
      SIM_URL: 'http://127.0.0.1:9',
      STRATA_SERVICE_TOKEN: 'test-service-token-0123456789',
      LOG_LEVEL: 'error',
    });
    platform = new Platform(cfg, createLogger('error', false));
    await platform.start();
    app = await buildApp(platform);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await platform?.stop();
    mock?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the browser's part: start at Strata, follow to the provider, let it redirect back to Strata's callback. */
  async function signIn(): Promise<{ callback: string }> {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    expect(start.statusCode).toBe(302);
    const toIdp = await fetch(start.headers.location as string, { redirect: 'manual' });
    const back = new URL(toIdp.headers.get('location')!);
    return { callback: `${back.pathname}${back.search}` };
  }

  it('advertises the provider to the sign-in page', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/banner' });
    expect(r.json().oidc).toEqual({ name: 'Test IdP', start: '/api/auth/oidc/start' });
  });

  it('signs an analyst in with the mapped role, and holds it to a second factor unless the provider asserted one', async () => {
    profile = { preferred_username: 'j.harper', name: 'Jo Harper', groups: ['strata-analysts'], amr: ['pwd'] };
    const { callback } = await signIn();
    const done = await app.inject({ method: 'GET', url: callback });
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('/');
    const cookie = String(done.headers['set-cookie']).split(';')[0]!;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ user: { username: 'j.harper', role: 'analyst', displayName: 'Jo Harper', mfaPending: true } });
  });

  it('counts a provider-asserted second factor as the second factor', async () => {
    profile = { preferred_username: 'k.osei', groups: ['strata-analysts'], amr: ['pwd', 'mfa'] };
    const done = await app.inject({ method: 'GET', url: (await signIn()).callback });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: String(done.headers['set-cookie']).split(';')[0]! } });
    expect(me.json().user).toMatchObject({ username: 'k.osei', mfaPending: false });
  });

  it('refuses a provider account with no mapped role', async () => {
    profile = { preferred_username: 'no.role', groups: ['everyone'] };
    const done = await app.inject({ method: 'GET', url: (await signIn()).callback });
    expect(done.statusCode).toBe(403);
    expect(done.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a token whose nonce is not the one this sign-in started with', async () => {
    profile = { preferred_username: 'tampered', groups: ['strata-viewers'] };
    nonceOverride = 'not-the-nonce';
    try {
      const done = await app.inject({ method: 'GET', url: (await signIn()).callback });
      expect(done.statusCode).toBe(401);
      expect(done.headers['set-cookie']).toBeUndefined();
    } finally {
      nonceOverride = null;
    }
  });

  it('refuses a callback whose state was never issued, or was already used', async () => {
    const bogus = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=abc&state=${randomBytes(8).toString('hex')}` });
    expect(bogus.statusCode).toBe(400);
    profile = { preferred_username: 'once', groups: ['strata-viewers'] };
    const { callback } = await signIn();
    expect((await app.inject({ method: 'GET', url: callback })).statusCode).toBe(302);
    expect((await app.inject({ method: 'GET', url: callback })).statusCode).toBe(400);
  });

  it('refuses a code presented with the wrong PKCE verifier', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    const toIdp = await fetch(start.headers.location as string, { redirect: 'manual' });
    const back = new URL(toIdp.headers.get('location')!);
    const token = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: 'wrong-verifier-value-for-the-test-only-xxxxxxxxxxxx' }) });
    expect(token.status).toBe(400);
  });

  it('refuses a disabled local account even when the provider vouches for it', async () => {
    const user = (await platform.auth.list()).find((u) => u.username === 'once')!;
    await platform.auth.update(user.id, { disabled: true });
    profile = { preferred_username: 'once', groups: ['strata-viewers'] };
    const done = await app.inject({ method: 'GET', url: (await signIn()).callback });
    expect(done.statusCode).toBe(403);
  });
});

describe('configuration', () => {
  it('needs a client, a redirect and a role map once an issuer is named, and https unless laboratory mode is set', async () => {
    const { oidcFromConfig } = await import('../src/auth/oidc.ts');
    const base = { OIDC_ROLE_CLAIM: 'groups', OIDC_NAME: 'IdP', OIDC_INSECURE_HTTP: 'false' as const };
    expect(oidcFromConfig({ ...base })).toBeNull();
    expect(() => oidcFromConfig({ ...base, OIDC_ISSUER: 'https://idp.example.mil' })).toThrow(/OIDC_CLIENT_ID, OIDC_REDIRECT_URI, OIDC_ROLE_MAP are not/);
    expect(() => oidcFromConfig({ ...base, OIDC_ISSUER: 'http://idp.example.mil', OIDC_CLIENT_ID: 'c', OIDC_REDIRECT_URI: 'https://s/cb', OIDC_ROLE_MAP: '{}' })).toThrow(/must be https/);
    expect(() => oidcFromConfig({ ...base, OIDC_ISSUER: 'https://idp.example.mil', OIDC_CLIENT_ID: 'c', OIDC_REDIRECT_URI: 'https://s/cb', OIDC_ROLE_MAP: '{"g":"superuser"}' })).toThrow(/not a role/);
    expect(oidcFromConfig({ ...base, OIDC_ISSUER: 'https://idp.example.mil', OIDC_CLIENT_ID: 'c', OIDC_REDIRECT_URI: 'https://s/cb', OIDC_ROLE_MAP: '{"g":"analyst"}' })).not.toBeNull();
  });
});
