import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ROLE_ORDER, passwordProblems, type Role, type UserRecord } from '@strata/domain';
import type { Db } from '../db/client.ts';
import { hashPassword, verifyPassword } from './passwords.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface LockoutPolicy {
  /** Consecutive failures for one username that lock it. */
  threshold: number;
  /** How long the username stays locked, in milliseconds. */
  windowMs: number;
}
export const DEFAULT_LOCKOUT: LockoutPolicy = { threshold: 5, windowMs: 60_000 };

/** Local identity: users with scrypt hashes, opaque session tokens stored only as SHA-256. */
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly ttlHours: number,
    private readonly lockout: LockoutPolicy = DEFAULT_LOCKOUT,
  ) {}

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

  /**
   * Returns a session token, or null for a wrong username or password, or { locked } while the username is locked. The
   * failures are in the database, so a restart does not clear a lock, and every instance sharing the database sees it.
   * Unknown usernames are counted too, so the lock does not reveal which names exist.
   */
  async login(username: string, password: string, ip: string | null): Promise<{ token: string; user: UserRecord; expiresAt: number } | { locked: true } | null> {
    const now = Date.now();
    const prior = (await this.db.query<{ failures: number; locked_until: number }>('SELECT failures, locked_until FROM login_lockouts WHERE username = $1', [username])).rows[0];
    const lockedUntil = prior ? Number(prior.locked_until) : 0;
    if (lockedUntil > now) return { locked: true };
    const r = (await this.db.query<{ id: string; username: string; display_name: string; role: Role; disabled: boolean; password_hash: string }>('SELECT * FROM users WHERE username = $1', [username])).rows[0];
    const ok = r && !r.disabled && (await verifyPassword(password, r.password_hash));
    if (!ok || !r) {
      // A lock that has run out starts the count again.
      const expired = lockedUntil > 0;
      const failures = (expired ? 0 : (prior?.failures ?? 0)) + 1;
      const until = failures >= this.lockout.threshold ? now + this.lockout.windowMs : 0;
      await this.db.query(
        'INSERT INTO login_lockouts (username, failures, locked_until, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO UPDATE SET failures = EXCLUDED.failures, locked_until = EXCLUDED.locked_until, updated_at = EXCLUDED.updated_at',
        [username, failures, until, now],
      );
      return null;
    }
    await this.clearLockout(username);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttlHours * 3600_000;
    await this.db.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip) VALUES ($1,$2,$3,$4,$5)', [sha(token), r.id, Date.now(), expiresAt, ip]);
    return { token, user: { id: r.id, username: r.username, displayName: r.display_name, role: r.role, disabled: false }, expiresAt };
  }

  async validate(token: string): Promise<UserRecord | null> {
    const r = (await this.db.query<{ id: string; username: string; display_name: string; role: Role; disabled: boolean; expires_at: number }>(
      'SELECT u.id, u.username, u.display_name, u.role, u.disabled, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1',
      [sha(token)],
    )).rows[0];
    if (!r || r.disabled || r.expires_at < Date.now()) return null;
    return { id: r.id, username: r.username, displayName: r.display_name, role: r.role, disabled: false };
  }

  async logout(token: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
  }
}
