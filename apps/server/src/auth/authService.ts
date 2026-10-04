import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ROLE_ORDER, type Role, type UserRecord } from '@strata/domain';
import type { Db } from '../db/client.ts';
import { hashPassword, verifyPassword } from './passwords.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Local identity: users with scrypt hashes, opaque session tokens stored only as SHA-256. */
export class AuthService {
  private failures = new Map<string, { n: number; until: number }>();

  constructor(
    private readonly db: Db,
    private readonly ttlHours: number,
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
    } else if (adminPassword) await this.create('admin', 'Administrator', 'administrator', adminPassword);
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

  /** Returns a session token or null. Repeated failures lock the username for 60 s. */
  async login(username: string, password: string, ip: string | null): Promise<{ token: string; user: UserRecord; expiresAt: number } | { locked: true } | null> {
    const f = this.failures.get(username);
    if (f && f.until > Date.now()) return { locked: true };
    const r = (await this.db.query<{ id: string; username: string; display_name: string; role: Role; disabled: boolean; password_hash: string }>('SELECT * FROM users WHERE username = $1', [username])).rows[0];
    const ok = r && !r.disabled && (await verifyPassword(password, r.password_hash));
    if (!ok || !r) {
      const n = (f?.n ?? 0) + 1;
      this.failures.set(username, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
      return null;
    }
    this.failures.delete(username);
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
