import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../http/guards.ts';
import type { Platform } from '../platform.ts';
import { mappedRole, pkceChallenge, providerAssertedMfa, randomToken } from '../auth/oidc.ts';

const PENDING_MS = 10 * 60_000;

/** A login name the local account can use: the provider's preferred name, reduced to the characters the console allows. */
const loginName = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const name = raw.toLowerCase().replace(/@.*$/, '').replace(/[^a-z0-9._-]/g, '').slice(0, 32);
  return name.length >= 3 ? name : null;
};

/** Sign-in through the configured identity provider. Registered only when one is configured. */
export function registerOidc(app: FastifyInstance, p: Platform): void {
  const oidc = p.oidc;
  if (!oidc) return;
  const cfg = oidc.cfg;

  app.get('/api/auth/oidc/start', async (_req, reply) => {
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    const now = Date.now();
    await p.db.query('DELETE FROM oidc_pending WHERE expires_at < $1', [now]);
    await p.db.query('INSERT INTO oidc_pending (state, nonce, verifier, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)', [state, nonce, verifier, now, now + PENDING_MS]);
    return reply.redirect(await oidc.authorizationUrl(state, nonce, pkceChallenge(verifier)));
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const q = req.query as { code?: unknown; state?: unknown; error?: unknown };
    if (typeof q.state !== 'string' || typeof q.code !== 'string') {
      return reply.code(400).send({ error: typeof q.error === 'string' ? 'the identity provider did not complete the sign-in' : 'the sign-in response is incomplete' });
    }
    // The state is single use: it is removed as it is read, so a replayed callback finds nothing.
    const pending = (await p.db.query<{ nonce: string; verifier: string; expires_at: number }>('DELETE FROM oidc_pending WHERE state = $1 RETURNING nonce, verifier, expires_at', [q.state])).rows[0];
    if (!pending || Number(pending.expires_at) < Date.now()) return reply.code(400).send({ error: 'the sign-in expired or was already used; start again' });

    let claims: Record<string, unknown>;
    try {
      claims = await oidc.completeSignIn(q.code, pending.verifier, pending.nonce);
    } catch (err) {
      // The reason is logged, not returned: it would tell an attacker which check failed.
      p.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'identity provider sign-in refused');
      await p.audit.append({ actor: 'oidc', role: 'none', action: 'login_failed', target: null, detail: { method: 'oidc' }, ip: req.ip });
      return reply.code(401).send({ error: 'the sign-in could not be verified' });
    }

    const role = mappedRole(claims[cfg.roleClaim], cfg.roleMap);
    if (!role) return reply.code(403).send({ error: 'this account has no role in this installation; ask an administrator' });
    const username = loginName(claims.preferred_username ?? claims.email ?? claims.sub);
    if (!username) return reply.code(403).send({ error: 'the account name from the provider cannot be used here' });
    const displayName = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 64) : username;

    const r = await p.auth.federatedSignIn({ username, displayName, role, providerMfa: providerAssertedMfa(claims), ip: req.ip });
    if ('disabled' in r) return reply.code(403).send({ error: 'this account is disabled' });
    const secure = Boolean(p.cfg.TLS_CERT_FILE) || p.cfg.COOKIE_SECURE === 'true';
    void reply.header('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(r.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${p.cfg.SESSION_TTL_HOURS * 3600}${secure ? '; Secure' : ''}`);
    await p.audit.append({ actor: r.user.username, role: r.user.role, action: 'login', target: null, detail: { method: 'oidc', mfa: r.mfa }, ip: req.ip });
    return reply.redirect('/');
  });
}
