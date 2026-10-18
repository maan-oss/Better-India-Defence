import { randomUUID } from 'node:crypto';
import {
  type AssetCategory,
  type AssetDetail,
  type AssetInput,
  type AssetNode,
  type AssetPatch,
  type AssetStatus,
  type AssetView,
  type DependencyEdge,
  type DependencyKind,
  type ImpactView,
  type PlanView,
  type SettableStatus,
  availabilityOf,
  dependentsOf,
  impactIf,
  effectiveStatus,
  isLowStock,
  isStockOut,
  planState,
  wouldCycle,
} from '@strata/domain';
import type { Db, Queryable } from '../db/client.ts';
import { DEMO_REGISTER } from './demoRegister.ts';

/** A refusal the caller can show: the HTTP status and a sentence an operator can act on. */
export class AssetError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface AssetRow {
  id: string;
  tag: string;
  name: string;
  classification: string;
  owner: string;
  shared_with: string[];
  stock_quantity: number | null;
  reorder_level: number | null;
  stock_unit: string | null;
  category: string;
  status: string;
  criticality: number;
  zone_id: string | null;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  commissioned_at: number | null;
  warranty_until: number | null;
  notes: string | null;
  source: string;
  updated_at: number;
  updated_by: string;
}

interface PlanRow {
  id: string;
  asset_id: string;
  title: string;
  interval_days: number;
  last_done_at: number | null;
  created_at: number;
}

const DEPENDENCY_LIMIT = 50;
const EVENT_LIMIT = 200;

/**
 * Asset and infrastructure register. Records are never deleted: a retired asset keeps its history and stays visible
 * as a cause of impairment for anything that still depends on it. Every change is written to the append-only
 * `asset_events` table in the same transaction as the change itself.
 */
export interface ReorderView {
  id: string;
  assetId: string;
  tag: string;
  name: string;
  quantity: number;
  reason: string;
  status: 'requested' | 'approved' | 'rejected';
  requestedBy: string;
  requestedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionNote: string | null;
}

export class AssetService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<AssetView[]> {
    const s = await this.snapshot();
    return this.build(s.assets, s.edges, s.plans);
  }

  /** The id an address refers to: an asset is named by its id or by its tag, the name an operator reads on the equipment. */
  async resolveId(ref: string): Promise<string> {
    const r = await this.db.query<{ id: string }>('SELECT id FROM assets WHERE id = $1 OR tag = $1', [ref]);
    const id = r.rows[0]?.id;
    if (!id) throw new AssetError('unknown asset', 404);
    return id;
  }

  /**
   * What a detail needs: the asset, everything that depends on it, and everything those depend on, since availability
   * follows the whole chain upstream. Loaded by the closure, so a detail does not read the whole register.
   */
  private async neighbourhood(id: string): Promise<{ assets: AssetRow[]; edges: DependencyEdge[]; plans: PlanRow[] }> {
    const ids = (
      await this.db.query<{ id: string }>(
        `WITH RECURSIVE down(id) AS (
           SELECT $1::text
           UNION
           SELECT d.asset_id FROM asset_dependencies d JOIN down ON d.depends_on_id = down.id
         ), reach(id) AS (
           SELECT id FROM down
           UNION
           SELECT d.depends_on_id FROM asset_dependencies d JOIN reach ON d.asset_id = reach.id
         )
         SELECT id FROM reach`,
        [id],
      )
    ).rows.map((r) => r.id);
    const [assets, edges, plans] = await Promise.all([
      this.db.query<AssetRow>('SELECT * FROM assets WHERE id = ANY($1) ORDER BY criticality DESC, tag', [ids]),
      this.db.query<{ asset_id: string; depends_on_id: string; kind: DependencyKind }>('SELECT asset_id, depends_on_id, kind FROM asset_dependencies WHERE asset_id = ANY($1)', [ids]),
      this.db.query<PlanRow>('SELECT * FROM maintenance_plans WHERE asset_id = ANY($1) ORDER BY created_at, id', [ids]),
    ]);
    return {
      assets: assets.rows,
      edges: edges.rows.map((e) => ({ assetId: e.asset_id, dependsOnId: e.depends_on_id, kind: e.kind })),
      plans: plans.rows,
    };
  }

  async detail(id: string): Promise<AssetDetail> {
    const s = await this.neighbourhood(id);
    const views = this.build(s.assets, s.edges, s.plans);
    const byId = new Map(views.map((v) => [v.id, v]));
    const asset = byId.get(id);
    if (!asset) throw new AssetError('unknown asset', 404);
    const upstream = s.edges
      .filter((e) => e.assetId === id)
      .map((e) => {
        const u = byId.get(e.dependsOnId)!;
        return { id: u.id, tag: u.tag, name: u.name, kind: e.kind, status: u.status, criticality: u.criticality };
      })
      .sort((a, b) => b.criticality - a.criticality || a.tag.localeCompare(b.tag));
    const dependents = dependentsOf(id, s.edges).map((d) => {
      const v = byId.get(d.id)!;
      return { id: v.id, tag: v.tag, name: v.name, depth: d.depth, status: v.status, criticality: v.criticality };
    });
    const events = await this.db.query<{ id: number; t: number; kind: string; detail: Record<string, unknown>; actor: string }>(
      'SELECT id, t, kind, detail, actor FROM asset_events WHERE asset_id = $1 ORDER BY t DESC, id DESC LIMIT $2',
      [id, EVENT_LIMIT],
    );
    return {
      asset,
      upstream,
      dependents,
      events: events.rows.map((r) => ({ id: Number(r.id), t: Number(r.t), kind: r.kind, detail: r.detail, actor: r.actor })),
    };
  }

  /** What would change if this asset moved to `status`. Read-only: nothing is recorded. */
  async impact(id: string, status: SettableStatus): Promise<ImpactView> {
    const s = await this.snapshot();
    const row = s.assets.find((a) => a.id === id);
    if (!row) throw new AssetError('unknown asset', 404);
    const byId = new Map(s.assets.map((a) => [a.id, a]));
    const rows = impactIf(id, status, nodes(s.assets), s.edges).map((r) => {
      const a = byId.get(r.id)!;
      return { ...r, tag: a.tag, name: a.name };
    });
    return { asset: { id: row.id, tag: row.tag, name: row.name }, status, rows };
  }

  async create(input: AssetInput, actor: string): Promise<AssetDetail> {
    const clash = await this.db.query('SELECT 1 FROM assets WHERE tag = $1', [input.tag]);
    if (clash.rows.length) throw new AssetError(`tag ${input.tag} is already in use`, 409);
    const id = `ast-${randomUUID().slice(0, 12)}`;
    const t = this.now();
    await this.db.transaction((q) => this.insertAsset(q, id, input, actor, t));
    return this.detail(id);
  }

  /** The classification, owner and sharing of the given records: what the access rule needs, without building views. */
  async accessRows(ids: string[]): Promise<{ id: string; classification: string; owner: string; shared_with: string[] }[]> {
    if (ids.length === 0) return [];
    return (await this.db.query<{ id: string; classification: string; owner: string; shared_with: string[] }>('SELECT id, classification, owner, shared_with FROM assets WHERE id = ANY($1)', [ids])).rows;
  }

  /** The tags already in the register: an import checks its rows against these before anything is written. */
  async tags(): Promise<Set<string>> {
    return new Set((await this.db.query<{ tag: string }>('SELECT tag FROM assets')).rows.map((r) => r.tag));
  }

  /**
   * Writes a checked import in one transaction: either every row is added or none is. A tag that was taken after the file
   * was checked refuses the whole import.
   */
  async importAssets(inputs: AssetInput[], actor: string): Promise<number> {
    const t = this.now();
    await this.db.transaction(async (q) => {
      const clash = await q.query<{ tag: string }>('SELECT tag FROM assets WHERE tag = ANY($1)', [inputs.map((i) => i.tag)]);
      if (clash.rows.length) throw new AssetError(`tag ${clash.rows[0]!.tag} is already in use`, 409);
      for (const input of inputs) await this.insertAsset(q, `ast-${randomUUID().slice(0, 12)}`, input, actor, t);
    });
    return inputs.length;
  }

  private async insertAsset(q: Queryable, id: string, input: AssetInput, actor: string, t: number): Promise<void> {
    if (input.stock && input.category !== 'supply') throw new AssetError('stock applies only to a supply item', 400);
    await q.query(
      `INSERT INTO assets (id, tag, name, category, status, criticality, zone_id, manufacturer, model, serial, commissioned_at, warranty_until, notes, source, created_by, updated_by, updated_at, classification, owner, shared_with, stock_quantity, reorder_level, stock_unit)
       VALUES ($1,$2,$3,$4,'in_service',$5,$6,$7,$8,$9,$10,$11,$12,'operator',$13,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [id, input.tag, input.name, input.category, input.criticality, input.zoneId ?? null, input.manufacturer ?? null, input.model ?? null, input.serial ?? null, input.commissionedAt ?? null, input.warrantyUntil ?? null, input.notes ?? null, actor, t, input.classification ?? 'UNCLASSIFIED', input.owner ?? 'site', input.sharedWith ?? [], input.stock?.quantity ?? null, input.stock?.reorderLevel ?? null, input.stock?.unit ?? null],
    );
    await event(q, id, 'created', { tag: input.tag, name: input.name, category: input.category, criticality: input.criticality, classification: input.classification ?? 'UNCLASSIFIED', owner: input.owner ?? 'site' }, actor, t);
  }

  async update(id: string, patch: AssetPatch, actor: string): Promise<AssetDetail> {
    const row = await this.requireAsset(id);
    assertEditable(row);
    const fields: [keyof AssetPatch, string, unknown][] = [
      ['name', 'name', row.name],
      ['category', 'category', row.category],
      ['criticality', 'criticality', row.criticality],
      ['zoneId', 'zone_id', row.zone_id],
      ['manufacturer', 'manufacturer', row.manufacturer],
      ['model', 'model', row.model],
      ['serial', 'serial', row.serial],
      ['commissionedAt', 'commissioned_at', row.commissioned_at],
      ['warrantyUntil', 'warranty_until', row.warranty_until],
      ['notes', 'notes', row.notes],
      ['classification', 'classification', row.classification],
      ['owner', 'owner', row.owner],
      ['sharedWith', 'shared_with', row.shared_with],
    ];
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, column, current] of fields) {
      if (!(key in patch) || patch[key] === undefined) continue;
      const next = patch[key] ?? null;
      if (JSON.stringify(current ?? null) === JSON.stringify(next)) continue;
      changed[key] = { from: current ?? null, to: next };
      values.push(next);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) return this.detail(id);
    const t = this.now();
    await this.db.transaction(async (q) => {
      values.push(actor, t);
      await q.query(`UPDATE assets SET ${sets.join(', ')}, updated_by = $${values.length - 1}, updated_at = $${values.length} WHERE id = $1`, values);
      await event(q, id, 'edited', { changed }, actor, t);
    });
    return this.detail(id);
  }

  async setStatus(id: string, status: SettableStatus, reason: string, actor: string): Promise<AssetDetail> {
    const row = await this.requireAsset(id);
    assertEditable(row);
    if (row.status === status) throw new AssetError(`the asset is already ${status.replace('_', ' ')}`, 400);
    const t = this.now();
    await this.db.transaction(async (q) => {
      await q.query('UPDATE assets SET status = $2, updated_by = $3, updated_at = $4 WHERE id = $1', [id, status, actor, t]);
      await event(q, id, 'status', { from: row.status, to: status, reason }, actor, t);
    });
    return this.detail(id);
  }

  /** Replaces what the asset depends on. Refuses self-dependency, unknown or retired targets, and any loop. */
  async setDependencies(id: string, dependsOn: { id: string; kind: DependencyKind }[], actor: string): Promise<AssetDetail> {
    const row = await this.requireAsset(id);
    assertEditable(row);
    if (dependsOn.length > DEPENDENCY_LIMIT) throw new AssetError(`an asset can depend on at most ${DEPENDENCY_LIMIT} others`, 400);
    const targets = dependsOn.map((d) => d.id);
    if (new Set(targets).size !== targets.length) throw new AssetError('the same dependency is listed twice', 400);
    if (targets.includes(id)) throw new AssetError('an asset cannot depend on itself', 400);
    const s = await this.snapshot();
    const byId = new Map(s.assets.map((a) => [a.id, a]));
    for (const target of targets) {
      const t = byId.get(target);
      if (!t) throw new AssetError(`unknown asset ${target}`, 400);
      if (t.status === 'retired') throw new AssetError(`${t.tag} is retired and cannot be a dependency`, 409);
    }
    if (wouldCycle(id, targets, s.edges)) throw new AssetError('this would create a dependency loop: an asset would depend on itself through others', 409);
    const before = s.edges.filter((e) => e.assetId === id).map((e) => ({ id: e.dependsOnId, kind: e.kind }));
    const t = this.now();
    await this.db.transaction(async (q) => {
      await q.query('DELETE FROM asset_dependencies WHERE asset_id = $1', [id]);
      for (const d of dependsOn) await q.query('INSERT INTO asset_dependencies (asset_id, depends_on_id, kind) VALUES ($1, $2, $3)', [id, d.id, d.kind]);
      await event(q, id, 'dependencies', { before, after: dependsOn }, actor, t);
    });
    return this.detail(id);
  }

  async addPlan(id: string, input: { title: string; intervalDays: number }, actor: string): Promise<AssetDetail> {
    const row = await this.requireAsset(id);
    assertEditable(row);
    const t = this.now();
    await this.db.transaction(async (q) => {
      await q.query('INSERT INTO maintenance_plans (id, asset_id, title, interval_days, last_done_at, created_by, created_at) VALUES ($1,$2,$3,$4,NULL,$5,$6)', [`plan-${randomUUID().slice(0, 12)}`, id, input.title, input.intervalDays, actor, t]);
      await event(q, id, 'maintenance', { action: 'plan_added', title: input.title, intervalDays: input.intervalDays }, actor, t);
    });
    return this.detail(id);
  }

  /** Records that a plan was carried out now. The next due date is counted from this moment. */
  async completePlan(id: string, planId: string, note: string | null, actor: string): Promise<AssetDetail> {
    const row = await this.requireAsset(id);
    assertEditable(row);
    const plan = await this.db.query<PlanRow>('SELECT * FROM maintenance_plans WHERE id = $1 AND asset_id = $2', [planId, id]);
    const p = plan.rows[0];
    if (!p) throw new AssetError('unknown maintenance plan', 404);
    const t = this.now();
    await this.db.transaction(async (q) => {
      await q.query('UPDATE maintenance_plans SET last_done_at = $2 WHERE id = $1', [planId, t]);
      await event(q, id, 'maintenance', { action: 'completed', title: p.title, previousDoneAt: p.last_done_at === null ? null : Number(p.last_done_at), note }, actor, t);
    });
    return this.detail(id);
  }

  /**
   * Retires an asset. Refused while any active asset still depends on it, so retirement cannot silently strand a
   * dependent: the dependents must be re-pointed first.
   */
  async retire(id: string, reason: string, actor: string): Promise<AssetDetail> {
    const row = await this.requireAsset(id);
    if (row.status === 'retired') throw new AssetError('the asset is already retired', 409);
    const s = await this.snapshot();
    const byId = new Map(s.assets.map((a) => [a.id, a]));
    const active = dependentsOf(id, s.edges)
      .map((d) => byId.get(d.id)!)
      .filter((a) => a.status !== 'retired');
    if (active.length) {
      const list = active.slice(0, 5).map((a) => a.tag).join(', ');
      throw new AssetError(`${active.length} active asset(s) still depend on it (${list}${active.length > 5 ? ', …' : ''}); re-point them first`, 409);
    }
    const t = this.now();
    await this.db.transaction(async (q) => {
      await q.query("UPDATE assets SET status = 'retired', updated_by = $2, updated_at = $3 WHERE id = $1", [id, actor, t]);
      await event(q, id, 'retired', { from: row.status, reason }, actor, t);
    });
    return this.detail(id);
  }

  /**
   * Inserts the synthetic demonstration register, once, into an empty demonstration database. Every row is marked
   * `source = 'demo'`, and the UI labels them as synthetic. Returns the number of assets inserted.
   */
  async seedDemo(): Promise<number> {
    const existing = await this.db.query<{ n: number }>("SELECT count(*)::int AS n FROM assets WHERE source = 'demo'");
    if ((existing.rows[0]?.n ?? 0) > 0) return 0;
    const t = this.now();
    await this.db.transaction(async (q) => {
      for (const a of DEMO_REGISTER.assets) {
        await q.query(
          `INSERT INTO assets (id, tag, name, category, status, criticality, zone_id, manufacturer, model, serial, commissioned_at, warranty_until, notes, source, created_by, updated_by, updated_at, stock_quantity, reorder_level, stock_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11,NULL,'demo','demo-seed','demo-seed',$12,$13,$14,$15)`,
          [a.id, a.tag, a.name, a.category, a.status, a.criticality, a.zoneId, a.manufacturer, a.model, t - 900 * DAY_MS, t + 540 * DAY_MS, t, a.stock?.quantity ?? null, a.stock?.reorderLevel ?? null, a.stock?.unit ?? null],
        );
        await event(q, a.id, 'created', { tag: a.tag, name: a.name, source: 'demo' }, 'demo-seed', t);
      }
      for (const d of DEMO_REGISTER.dependencies) await q.query('INSERT INTO asset_dependencies (asset_id, depends_on_id, kind) VALUES ($1,$2,$3)', [d.assetId, d.dependsOnId, d.kind]);
      for (const p of DEMO_REGISTER.plans) {
        const last = p.lastDoneDaysAgo === null ? null : t - p.lastDoneDaysAgo * DAY_MS;
        await q.query('INSERT INTO maintenance_plans (id, asset_id, title, interval_days, last_done_at, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [p.id, p.assetId, p.title, p.intervalDays, last, 'demo-seed', t]);
      }
    });
    return DEMO_REGISTER.assets.length;
  }

  private async requireAsset(id: string): Promise<AssetRow> {
    const r = await this.db.query<AssetRow>('SELECT * FROM assets WHERE id = $1', [id]);
    const row = r.rows[0];
    if (!row) throw new AssetError('unknown asset', 404);
    return row;
  }

  /** A receipt (positive) or an issue (negative) of a stock item. The quantity never goes below zero. */
  async changeStock(id: string, change: number, reason: string, actor: string): Promise<AssetDetail> {
    const row = await this.requireAsset(id);
    assertEditable(row);
    if (row.category !== 'supply' || row.stock_quantity === null) throw new AssetError('this is not a stock item', 400);
    const from = Number(row.stock_quantity);
    const to = from + change;
    if (to < 0) throw new AssetError(`only ${from} ${row.stock_unit ?? 'each'} on hand; cannot issue ${-change}`, 409);
    const t = this.now();
    await this.db.transaction(async (q) => {
      await q.query('UPDATE assets SET stock_quantity = $2, updated_by = $3, updated_at = $4 WHERE id = $1', [id, to, actor, t]);
      await event(q, id, change > 0 ? 'stock_received' : 'stock_issued', { from, to, change, reason }, actor, t);
    });
    return this.detail(id);
  }

  /** A request to reorder a stock item. It takes no effect until a different person approves it. */
  async requestReorder(id: string, quantity: number, reason: string, actor: string): Promise<AssetDetail> {
    const row = await this.requireAsset(id);
    assertEditable(row);
    if (row.category !== 'supply' || row.stock_quantity === null) throw new AssetError('reorders apply to stock items only', 400);
    const requestId = `reo-${randomUUID().slice(0, 12)}`;
    const t = this.now();
    await this.db.transaction(async (q) => {
      await q.query('INSERT INTO reorder_requests (id, asset_id, quantity, reason, status, requested_by, requested_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [requestId, id, quantity, reason, 'requested', actor, t]);
      await event(q, id, 'reorder_requested', { requestId, quantity, reason }, actor, t);
    });
    return this.detail(id);
  }

  /** Approves or rejects a reorder. The person who asked cannot decide it. */
  async decideReorder(requestId: string, decision: 'approve' | 'reject', note: string | null, actor: string): Promise<ReorderView> {
    const r = (await this.db.query<{ id: string; asset_id: string; quantity: number; status: string; requested_by: string }>('SELECT id, asset_id, quantity, status, requested_by FROM reorder_requests WHERE id = $1', [requestId])).rows[0];
    if (!r) throw new AssetError('unknown reorder request', 404);
    if (r.status !== 'requested') throw new AssetError(`this reorder is already ${r.status}`, 409);
    if (r.requested_by === actor) throw new AssetError('a reorder must be decided by someone other than the person who requested it', 403);
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const t = this.now();
    await this.db.transaction(async (q) => {
      await q.query('UPDATE reorder_requests SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1', [requestId, status, actor, t, note]);
      await event(q, r.asset_id, `reorder_${status}`, { requestId, quantity: Number(r.quantity), note }, actor, t);
    });
    return (await this.reorders(undefined, requestId))[0]!;
  }

  /** Reorder requests, newest first, with the asset each is for. */
  async reorders(status?: string, id?: string): Promise<ReorderView[]> {
    const params = [status, id].filter((v): v is string => v !== undefined);
    const clauses = [status ? `r.status = $${params.indexOf(status) + 1}` : null, id ? `r.id = $${params.indexOf(id) + 1}` : null].filter(Boolean);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = (
      await this.db.query<{ id: string; asset_id: string; tag: string; name: string; quantity: number; reason: string; status: ReorderView['status']; requested_by: string; requested_at: number; decided_by: string | null; decided_at: number | null; decision_note: string | null }>(
        `SELECT r.id, r.asset_id, a.tag, a.name, r.quantity, r.reason, r.status, r.requested_by, r.requested_at, r.decided_by, r.decided_at, r.decision_note
         FROM reorder_requests r JOIN assets a ON a.id = r.asset_id ${where} ORDER BY r.requested_at DESC, r.id DESC LIMIT 200`,
        params,
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
      tag: r.tag,
      name: r.name,
      quantity: Number(r.quantity),
      reason: r.reason,
      status: r.status,
      requestedBy: r.requested_by,
      requestedAt: Number(r.requested_at),
      decidedBy: r.decided_by,
      decidedAt: r.decided_at === null ? null : Number(r.decided_at),
      decisionNote: r.decision_note,
    }));
  }

  private async snapshot(): Promise<{ assets: AssetRow[]; edges: DependencyEdge[]; plans: PlanRow[] }> {
    const [assets, edges, plans] = await Promise.all([
      this.db.query<AssetRow>('SELECT * FROM assets ORDER BY criticality DESC, tag'),
      this.db.query<{ asset_id: string; depends_on_id: string; kind: string }>('SELECT asset_id, depends_on_id, kind FROM asset_dependencies'),
      this.db.query<PlanRow>('SELECT * FROM maintenance_plans ORDER BY created_at, id'),
    ]);
    return {
      assets: assets.rows,
      edges: edges.rows.map((e) => ({ assetId: e.asset_id, dependsOnId: e.depends_on_id, kind: e.kind as DependencyKind })),
      plans: plans.rows,
    };
  }

  private build(rows: AssetRow[], edges: DependencyEdge[], plans: PlanRow[]): AssetView[] {
    const now = this.now();
    const availability = availabilityOf(nodes(rows), edges);
    const byAsset = new Map<string, PlanView[]>();
    for (const p of plans) {
      const last = p.last_done_at === null ? null : Number(p.last_done_at);
      const list = byAsset.get(p.asset_id) ?? [];
      list.push({ id: p.id, title: p.title, intervalDays: Number(p.interval_days), lastDoneAt: last, due: planState(last, Number(p.interval_days), now) });
      byAsset.set(p.asset_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      tag: r.tag,
      name: r.name,
      category: r.category as AssetCategory,
      status: r.status as AssetStatus,
      criticality: Number(r.criticality),
      zoneId: r.zone_id,
      manufacturer: r.manufacturer,
      model: r.model,
      serial: r.serial,
      commissionedAt: r.commissioned_at === null ? null : Number(r.commissioned_at),
      warrantyUntil: r.warranty_until === null ? null : Number(r.warranty_until),
      notes: r.notes,
      stock: r.stock_quantity === null ? null : stockView(r),
      classification: r.classification as AssetView['classification'],
      owner: r.owner,
      sharedWith: [...(r.shared_with ?? [])],
      source: r.source === 'demo' ? 'demo' : 'operator',
      updatedAt: Number(r.updated_at),
      updatedBy: r.updated_by,
      availability: availability.get(r.id)!,
      plans: byAsset.get(r.id) ?? [],
    }));
  }
}

const stockView = (r: AssetRow) => {
  const quantity = Number(r.stock_quantity);
  const reorderLevel = Number(r.reorder_level ?? 0);
  return { quantity, reorderLevel, unit: r.stock_unit ?? 'each', lowStock: isLowStock(quantity, reorderLevel), outOfStock: isStockOut(r.category, quantity) };
};

const DAY_MS = 86_400_000;

function nodes(rows: AssetRow[]): AssetNode[] {
  return rows.map((r) => ({ id: r.id, status: effectiveStatus(r.status as AssetStatus, r.category, quantityOf(r)), criticality: Number(r.criticality) }));
}

const quantityOf = (r: AssetRow): number | null => (r.stock_quantity === null ? null : Number(r.stock_quantity));

function assertEditable(row: AssetRow): void {
  if (row.status === 'retired') throw new AssetError('a retired asset is read-only', 409);
}

async function event(q: Queryable, assetId: string, kind: string, detail: Record<string, unknown>, actor: string, t: number): Promise<void> {
  await q.query('INSERT INTO asset_events (asset_id, t, kind, detail, actor) VALUES ($1, $2, $3, $4::jsonb, $5)', [assetId, t, kind, JSON.stringify(detail), actor]);
}
