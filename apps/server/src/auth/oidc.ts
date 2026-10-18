import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { ROLE_ORDER, type Role } from '@strata/domain';

/**
 * OpenID Connect sign-in (authorization code flow with PKCE). The identity provider authenticates the person; this
 * module checks what it returns: the state and nonce this server issued, the PKCE verifier, and the ID token's
 * signature (RS256 only, against the provider's published keys), issuer, audience, expiry and nonce. The role comes from
 * a claim (groups by default) through a mapping the installation configures; without a mapped role, sign-in is refused.
 */

export interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

const b64url = (buf: Buffer) => buf.toString('base64url');
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export interface VerifyOptions {
  issuer: string;
  audience: string;
  nonce: string;
  now?: number;
  leewaySeconds?: number;
}

/** Splits a compact JWS, checks the header and the signature against the key set, and returns the claims. */
export function verifyIdToken(token: string, keys: Jwk[], opts: VerifyOptions): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('the ID token is not a compact JWS');
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
  // Only RS256 is accepted. Not "none", and not an HMAC algorithm keyed with a public key.
  if (header.alg !== 'RS256') throw new Error(`the ID token uses ${String(header.alg)}; only RS256 is accepted`);
  const candidates = keys.filter((k) => k.kty === 'RSA' && (header.kid ? k.kid === header.kid : true));
  if (candidates.length === 0) throw new Error('no published key matches the ID token');
  const signed = Buffer.from(`${h}.${p}`);
  const signature = Buffer.from(s, 'base64url');
  const valid = candidates.some((k) => {
    const key = createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' });
    return createVerify('RSA-SHA256').update(signed).verify(key, signature);
  });
  if (!valid) throw new Error('the ID token signature does not verify');

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const leeway = opts.leewaySeconds ?? 60;
  if (claims.iss !== opts.issuer) throw new Error('the ID token was issued by another issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) throw new Error('the ID token is for another client');
  if (aud.length > 1 && claims.azp !== opts.audience) throw new Error('the ID token has several audiences and is not for this client');
  if (typeof claims.exp !== 'number' || claims.exp + leeway < now) throw new Error('the ID token has expired');
  if (typeof claims.iat === 'number' && claims.iat > now + leeway) throw new Error('the ID token is issued in the future');
  if (claims.nonce !== opts.nonce) throw new Error('the ID token nonce does not match this sign-in');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new Error('the ID token has no subject');
  return claims;
}

/** The most privileged role any of the claim's values maps to, or null when none does. */
export function mappedRole(claimValues: unknown, map: Partial<Record<string, Role>>): Role | null {
  const values = Array.isArray(claimValues) ? claimValues : typeof claimValues === 'string' ? [claimValues] : [];
  let best: Role | null = null;
  for (const v of values) {
    const role = typeof v === 'string' ? map[v] : undefined;
    if (role && (best === null || ROLE_ORDER.indexOf(role) > ROLE_ORDER.indexOf(best))) best = role;
  }
  return best;
}

/** Whether the ID token records a second factor at the provider (amr values of the RFC 8176 kind). */
export const providerAssertedMfa = (claims: Record<string, unknown>) => {
  const amr = Array.isArray(claims.amr) ? (claims.amr as unknown[]) : [];
  return amr.some((v) => v === 'mfa' || v === 'otp' || v === 'hwk' || v === 'swk');
};

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  roleClaim: string;
  roleMap: Partial<Record<string, Role>>;
  name: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** The identity provider configured for this installation, or null when none is configured. */
export function oidcFromConfig(c: {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  OIDC_ROLE_CLAIM: string;
  OIDC_ROLE_MAP?: string;
  OIDC_NAME: string;
  OIDC_INSECURE_HTTP: 'true' | 'false';
}): OidcClient | null {
  if (!c.OIDC_ISSUER) return null;
  const missing = (['OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI', 'OIDC_ROLE_MAP'] as const).filter((k) => !c[k]);
  if (missing.length) throw new Error(`OIDC_ISSUER is set but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not`);
  const map: Partial<Record<string, Role>> = JSON.parse(c.OIDC_ROLE_MAP!);
  for (const [group, role] of Object.entries(map)) {
    if (!ROLE_ORDER.includes(role as Role)) throw new Error(`OIDC_ROLE_MAP maps ${group} to ${String(role)}, which is not a role`);
  }
  if (c.OIDC_INSECURE_HTTP !== 'true') {
    for (const [name, value] of [['OIDC_ISSUER', c.OIDC_ISSUER], ['OIDC_REDIRECT_URI', c.OIDC_REDIRECT_URI]] as const) {
      if (!value!.startsWith('https://')) throw new Error(`${name} must be https (or set OIDC_INSECURE_HTTP=true for a laboratory)`);
    }
  }
  return new OidcClient({
    issuer: c.OIDC_ISSUER,
    clientId: c.OIDC_CLIENT_ID!,
    clientSecret: c.OIDC_CLIENT_SECRET ?? null,
    redirectUri: c.OIDC_REDIRECT_URI!,
    roleClaim: c.OIDC_ROLE_CLAIM,
    roleMap: map,
    name: c.OIDC_NAME,
  });
}

/** The provider's endpoints and keys, fetched from its discovery document and cached. */
export class OidcClient {
  private discovery: { at: number; doc: Discovery } | null = null;
  private keys: { at: number; keys: Jwk[] } | null = null;

  constructor(
    readonly cfg: OidcConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async getDiscovery(): Promise<Discovery> {
    if (this.discovery && Date.now() - this.discovery.at < 3600_000) return this.discovery.doc;
    const res = await this.fetchImpl(`${this.cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
    const doc = (await res.json()) as Discovery;
    if (doc.issuer !== this.cfg.issuer) throw new Error('the discovery document names another issuer');
    this.discovery = { at: Date.now(), doc };
    return doc;
  }

  private async getKeys(refresh = false): Promise<Jwk[]> {
    if (!refresh && this.keys && Date.now() - this.keys.at < 600_000) return this.keys.keys;
    const doc = await this.getDiscovery();
    const res = await this.fetchImpl(doc.jwks_uri, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`key set unavailable: ${res.status}`);
    const keys = ((await res.json()) as { keys: Jwk[] }).keys;
    this.keys = { at: Date.now(), keys };
    return keys;
  }

  /** The address the browser is sent to: the provider's login page, with state, nonce and the PKCE challenge. */
  async authorizationUrl(state: string, nonce: string, challenge: string): Promise<string> {
    const doc = await this.getDiscovery();
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  /** Exchanges the code for tokens, presenting the PKCE verifier, and returns the verified ID token's claims. */
  async completeSignIn(code: string, verifier: string, nonce: string): Promise<Record<string, unknown>> {
    const doc = await this.getDiscovery();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri, code_verifier: verifier, client_id: this.cfg.clientId });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.cfg.clientSecret) headers.authorization = `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`;
    const res = await this.fetchImpl(doc.token_endpoint, { method: 'POST', headers, body: form.toString() });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || !body.id_token) throw new Error(`the provider refused the code${body.error ? `: ${body.error}` : ''}`);
    const audience = this.cfg.clientId;
    const opts: VerifyOptions = { issuer: this.cfg.issuer, audience, nonce };
    try {
      return verifyIdToken(body.id_token, await this.getKeys(), opts);
    } catch {
      // A key set rotated since it was cached: fetch it again once before refusing.
      return verifyIdToken(body.id_token, await this.getKeys(true), opts);
    }
  }
}
