import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ROLE_ORDER, base32Encode, otpauthUri, passwordProblems, verifyTotp, type Role, type UserRecord } from '@strata/domain';
import type { Db } from '../db/client.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import { openSecret, sealSecret } from './secretBox.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface LockoutPolicy {
  /** Consecutive failures for one username that lock it. */
  threshold: number;
  /** How long the username stays locked, in milliseconds. */
  windowMs: number;
}
export const DEFAULT_LOCKOUT: LockoutPolicy = { threshold: 5, windowMs: 60_000 };

/** Roles that must have a second factor before they can do anything (see `mfaRequired`). */
export const PRIVILEGED_ROLES: readonly Role[] = ['administrator', 'analyst'];

export interface SecondFactorPolicy {
  /** Storage key (32 bytes) that seals the secrets. Without one, second factors cannot be enrolled. */
  key: Buffer | null;
  /** When true, privileged roles must enrol before they can use the service. */
  required: boolean;
  issuer: string;
  /** The clock for code checks. Tests substitute one, because a code is accepted once per 30-second step. */
  clock?: () => number;
}
const DEFAULT_MFA: SecondFactorPolicy = { key: null, required: false, issuer: 'Strata' };
const CHALLENGE_MS = 5 * 60_000;

export type SignIn = { token: string; user: UserRecord; expiresAt: number; mfa: 'ok' | 'enrol' };

export interface AuthOptions {
  lockout?: LockoutPolicy;
  mfa?: SecondFactorPolicy;
}

/** Local identity: users with scrypt hashes, opaque session tokens stored only as SHA-256. */
export class AuthService {
  private readonly lockout: LockoutPolicy;
  private readonly mfa: SecondFactorPolicy;

  constructor(
    private readonly db: Db,
    private readonly ttlHours: number,
    options: AuthOptions = {},
  ) {
    this.lockout = options.lockout ?? DEFAULT_LOCKOUT;
    this.mfa = options.mfa ?? DEFAULT_MFA;
  }

  async ensureUsers(demo: boolean, demoPassword: string, adminPassword: string | undefined): Promise<void> {
    const n = (await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0]!.n;
    if (n > 0) return;
    if (demo) {
      const users: [string, string, Role][] = [
        ['viewer', 'Demo Viewer', 'viewer'],
        ['operator', 'Demo Operator', 'operator'],
        ['analyst', 'Demo Analyst', 'analyst'],
        ['admin', 'Demo Administrator', 'administrator'],
      ];
      for (const [u, d, r] of users) await this.create(u, d, r, demoPassword);
    } else if (adminPassword) {
      // An administrator-set password is held to the same policy as one set in the console.
      const problems = passwordProblems(adminPassword, 'admin');
      if (problems.length) throw new Error(`STRATA_ADMIN_PASSWORD does not meet the password policy: ${problems.join(', ')}`);
      await this.create('admin', 'Administrator', 'administrator', adminPassword);
    }
  }

  async count(): Promise<number> {
    return (await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0]!.n;
  }

  async create(username: string, displayName: string, role: Role, password: string): Promise<UserRecord> {
    if (!ROLE_ORDER.includes(role)) throw new Error('invalid role');
    const id = `usr-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await this.db.query('INSERT INTO users (id, username, display_name, role, password_hash, disabled, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,false,$6,$6)', [id, username, displayName, role, await hashPassword(password), now]);
    return { id, username, displayName, role, disabled: false };
  }

  async update(id: string, patch: { role?: Role; disabled?: boolean; displayName?: string; password?: string }): Promise<UserRecord | null> {
    const cur = (await this.db.query<{ id: string; username: string; display_name: string; role: Role; disabled: boolean }>('SELECT * FROM users WHERE id = $1', [id])).rows[0];
    if (!cur) return null;
    const hash = patch.password ? await hashPassword(patch.password) : null;
    await this.db.query('UPDATE users SET role=$2, disabled=$3, display_name=$4, password_hash=COALESCE($5, password_hash), updated_at=$6 WHERE id=$1', [id, patch.role ?? cur.role, patch.disabled ?? cur.disabled, patch.displayName ?? cur.display_name, hash, Date.now()]);
    if (patch.disabled || patch.role || patch.password) await this.db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    return { id, username: cur.username, displayName: patch.displayName ?? cur.display_name, role: patch.role ?? cur.role, disabled: patch.disabled ?? cur.disabled };
  }

  async list(): Promise<UserRecord[]> {
    return (await this.db.query<{ id: string; username: string; display_name: string; role: Role; disabled: boolean }>('SELECT id, username, display_name, role, disabled FROM users ORDER BY username')).rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, role: r.role, disabled: r.disabled }));
  }

  /** Forgets the failures for a username, so it can sign in again at once (an administrator's action, audited by the route). */
  async clearLockout(username: string): Promise<void> {
    await this.db.query('DELETE FROM login_lockouts WHERE username = $1', [username]);
  }

  private async recordFailure(username: string, prior: { failures: number; locked_until: number } | undefined, now: number): Promise<void> {
    // A lock that has run out starts the count again.
    const lockedUntil = prior ? Number(prior.locked_until) : 0;
    const expired = lockedUntil > 0;
    const failures = (expired ? 0 : (prior?.failures ?? 0)) + 1;
    const until = failures >= this.lockout.threshold ? now + this.lockout.windowMs : 0;
    await this.db.query(
      'INSERT INTO login_lockouts (username, failures, locked_until, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO UPDATE SET failures = EXCLUDED.failures, locked_until = EXCLUDED.locked_until, updated_at = EXCLUDED.updated_at',
      [username, failures, until, now],
    );
  }

  /**
   * The first step of sign-in. Returns a session, or { mfa: 'required', challenge } when the account has a second factor
   * (no session until the code is checked), or null for a wrong username or password, or { locked } while locked.
   * Failures are in the database, so a restart does not clear a lock, and every instance sharing the database sees it.
   * Unknown usernames are counted too, so the lock does not reveal which names exist.
   */
  async login(username: string, password: string, ip: string | null): Promise<SignIn | { mfa: 'required'; challenge: string; expiresAt: number } | { locked: true } | null> {
    const now = Date.now();
    const prior = (await this.db.query<{ failures: number; locked_until: number }>('SELECT failures, locked_until FROM login_lockouts WHERE username = $1', [username])).rows[0];
    if (prior && Number(prior.locked_until) > now) return { locked: true };
    const r = (await this.db.query<{ id: string; username: string; display_name: string; role: Role; disabled: boolean; password_hash: string; totp_enabled: boolean }>('SELECT * FROM users WHERE username = $1', [username])).rows[0];
    const ok = r && !r.disabled && (await verifyPassword(password, r.password_hash));
    if (!ok || !r) {
      await this.recordFailure(username, prior, now);
      return null;
    }
    await this.clearLockout(username);
    if (r.totp_enabled) {
      const challenge = randomBytes(32).toString('base64url');
      const expiresAt = now + CHALLENGE_MS;
      await this.db.query('INSERT INTO mfa_challenges (token_hash, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)', [sha(challenge), r.id, now, expiresAt]);
      return { mfa: 'required', challenge, expiresAt };
    }
    // Without a factor yet, a privileged account gets a session that may only enrol one.
    return this.openSession(r.id, r.username, r.display_name, r.role, ip, now, !this.enrolmentPending(r.role));
  }

  private codeClock(): number {
    return this.mfa.clock ? this.mfa.clock() : Date.now();
  }

  /** Whether a privileged account signing in now must enrol a second factor before it can use the service. */
  private enrolmentPending(role: Role): boolean {
    return this.mfa.required && PRIVILEGED_ROLES.includes(role);
  }

  private async openSession(id: string, username: string, displayName: string, role: Role, ip: string | null, now: number, verified: boolean): Promise<SignIn> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + this.ttlHours * 3600_000;
    await this.db.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, mfa_verified) VALUES ($1,$2,$3,$4,$5,$6)', [sha(token), id, now, expiresAt, ip, verified]);
    return { token, user: { id, username, displayName, role, disabled: false }, expiresAt, mfa: verified ? 'ok' : 'enrol' };
  }

  /**
   * The second step: a code from the authenticator, for the challenge the password step issued. The challenge is single
   * use, a wrong code counts against the username like a wrong password, and a code is accepted once.
   */
  async verifySecondFactor(challenge: string, code: string, ip: string | null): Promise<SignIn | null> {
    const now = Date.now();
    const c = (await this.db.query<{ user_id: string; expires_at: number }>('DELETE FROM mfa_challenges WHERE token_hash = $1 RETURNING user_id, expires_at', [sha(challenge)])).rows[0];
    if (!c || Number(c.expires_at) < now || !this.mfa.key) return null;
    const u = (await this.db.query<{ id: string; username: string; display_name: string; role: Role; disabled: boolean; totp_secret: string | null; totp_last_step: number }>('SELECT id, username, display_name, role, disabled, totp_secret, totp_last_step FROM users WHERE id = $1 AND totp_enabled', [c.user_id])).rows[0];
    if (!u || u.disabled || !u.totp_secret) return null;
    const secret = openSecret(this.mfa.key, u.totp_secret);
    const check = verifyTotp(secret, code, this.codeClock(), Number(u.totp_last_step));
    if (!check.ok) {
      const prior = (await this.db.query<{ failures: number; locked_until: number }>('SELECT failures, locked_until FROM login_lockouts WHERE username = $1', [u.username])).rows[0];
      await this.recordFailure(u.username, prior, now);
      return null;
    }
    await this.db.query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [u.id, check.step]);
    await this.clearLockout(u.username);
    return this.openSession(u.id, u.username, u.display_name, u.role, ip, now, true);
  }

  /**
   * Starts enrolling a second factor for the signed-in user: a fresh secret, sealed under the storage key, and the
   * address an authenticator app reads from a QR code. The factor is not active until `confirmSecondFactor` is given a code.
   */
  async beginSecondFactor(userId: string, username: string): Promise<{ secret: string; uri: string }> {
    if (!this.mfa.key) throw new Error('second factors need the storage key (STORAGE_ENCRYPTION_KEY) to protect their secrets');
    const raw = randomBytes(20);
    await this.db.query('UPDATE users SET totp_secret = $2, totp_enabled = false WHERE id = $1', [userId, sealSecret(this.mfa.key, raw)]);
    return { secret: base32Encode(raw), uri: otpauthUri(this.mfa.issuer, username, raw) };
  }

  /** Activates the pending factor when the code matches it, and marks the enrolling session as verified. */
  async confirmSecondFactor(userId: string, code: string, sessionToken: string): Promise<boolean> {
    if (!this.mfa.key) return false;
    const u = (await this.db.query<{ totp_secret: string | null; totp_last_step: number }>('SELECT totp_secret, totp_last_step FROM users WHERE id = $1', [userId])).rows[0];
    if (!u?.totp_secret) return false;
    const check = verifyTotp(openSecret(this.mfa.key, u.totp_secret), code, this.codeClock(), Number(u.totp_last_step));
    if (!check.ok) return false;
    await this.db.query('UPDATE users SET totp_enabled = true, totp_last_step = $2 WHERE id = $1', [userId, check.step]);
    await this.db.query('UPDATE sessions SET mfa_verified = true WHERE token_hash = $1', [sha(sessionToken)]);
    return true;
  }

  /** Removes an account's second factor (a lost device), and ends its sessions so the next sign-in enrols again. */
  async removeSecondFactor(userId: string): Promise<void> {
    await this.db.query('UPDATE users SET totp_secret = NULL, totp_enabled = false, totp_last_step = 0 WHERE id = $1', [userId]);
    await this.db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  async secondFactorState(userId: string): Promise<{ enabled: boolean; pending: boolean }> {
    const r = (await this.db.query<{ totp_enabled: boolean; totp_secret: string | null }>('SELECT totp_enabled, totp_secret FROM users WHERE id = $1', [userId])).rows[0];
    return { enabled: Boolean(r?.totp_enabled), pending: Boolean(r?.totp_secret) && !r?.totp_enabled };
  }

  /** The signed-in account for a session token. `mfaPending` is set while the second factor still has to be enrolled. */
  async validate(token: string): Promise<(UserRecord & { mfaPending: boolean }) | null> {
    const r = (await this.db.query<{ id: string; username: string; display_name: string; role: Role; disabled: boolean; expires_at: number; mfa_verified: boolean }>(
      'SELECT u.id, u.username, u.display_name, u.role, u.disabled, s.expires_at, s.mfa_verified FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1',
      [sha(token)],
    )).rows[0];
    if (!r || r.disabled || r.expires_at < Date.now()) return null;
    return { id: r.id, username: r.username, displayName: r.display_name, role: r.role, disabled: false, mfaPending: !r.mfa_verified };
  }

  async logout(token: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
  }
}

