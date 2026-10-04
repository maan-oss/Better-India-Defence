import { createHash } from 'node:crypto';
import type { Db } from '../db/client.ts';

/**
 * Tamper-evident audit log. Each record includes the SHA-256 of the previous record, so any modification
 * or deletion breaks the chain (verify()). The table also has a trigger rejecting UPDATE/DELETE. Records
 * are appended through a single serialised writer to keep the chain linear.
 */
export interface AuditInput {
  actor: string;
  role: string;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditRecord extends Required<Omit<AuditInput, 'detail'>> {
  seq: number;
  t: number;
  detail: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

/** Key-order-independent JSON: JSONB storage reorders object keys, so hashes must not depend on order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const canonical = (r: { t: number; actor: string; role: string; action: string; target: string | null; detail: unknown; ip: string | null }) =>
  stableJson([Number(r.t), r.actor, r.role, r.action, r.target, r.detail, r.ip]);

export class AuditLog {
  private chain: Promise<unknown> = Promise.resolve();
  private lastHash: string | null = null;

  constructor(private readonly db: Db) {}

  append(input: AuditInput): Promise<void> {
    const run = async () => {
      if (this.lastHash === null) {
        const last = await this.db.query<{ hash: string }>('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1');
        this.lastHash = last.rows[0]?.hash ?? 'GENESIS';
      }
      // Round-trip detail through JSON so what we hash is exactly what JSONB will hand back (no undefined, no Dates).
      const detail = JSON.parse(JSON.stringify(input.detail ?? {})) as Record<string, unknown>;
      const rec = { t: Date.now(), actor: input.actor, role: input.role, action: input.action, target: input.target ?? null, detail, ip: input.ip ?? null };
      const hash = createHash('sha256').update(this.lastHash).update(canonical(rec)).digest('hex');
      await this.db.query('INSERT INTO audit_events (t, actor, role, action, target, detail, ip, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)', [
        rec.t,
        rec.actor,
        rec.role,
        rec.action,
        rec.target,
        JSON.stringify(rec.detail),
        rec.ip,
        this.lastHash,
        hash,
      ]);
      this.lastHash = hash;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async verify(): Promise<{ ok: boolean; checked: number; brokenAt: number | null }> {
    const rows = (await this.db.query<AuditRecord>('SELECT seq, t, actor, role, action, target, detail, ip, prev_hash, hash FROM audit_events ORDER BY seq')).rows;
    let prev = 'GENESIS';
    for (const r of rows) {
      const h = createHash('sha256').update(prev).update(canonical(r)).digest('hex');
      if (r.prev_hash !== prev || r.hash !== h) return { ok: false, checked: rows.length, brokenAt: r.seq };
      prev = r.hash;
    }
    return { ok: true, checked: rows.length, brokenAt: null };
  }
}
