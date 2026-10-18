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

  async detail(id: string): Promise<AssetDetail> {
    const s = await this.snapshot();
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
    await this.db.transaction(async (q) => {
      await q.query(
        `INSERT INTO assets (id, tag, name, category, status, criticality, zone_id, manufacturer, model, serial, commissioned_at, warranty_until, notes, source, created_by, updated_by, updated_at, classification, owner, shared_with)
         VALUES ($1,$2,$3,$4,'in_service',$5,$6,$7,$8,$9,$10,$11,$12,'operator',$13,$13,$14,$15,$16,$17)`,
        [id, input.tag, input.name, input.category, input.criticality, input.zoneId ?? null, input.manufacturer ?? null, input.model ?? null, input.serial ?? null, input.commissionedAt ?? null, input.warrantyUntil ?? null, input.notes ?? null, actor, t, input.classification ?? 'UNCLASSIFIED', input.owner ?? 'site', input.sharedWith ?? []],
      );
      await event(q, id, 'created', { tag: input.tag, name: input.name, category: input.category, criticality: input.criticality, classification: input.classification ?? 'UNCLASSIFIED', owner: input.owner ?? 'site' }, actor, t);
    });
    return this.detail(id);
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
          `INSERT INTO assets (id, tag, name, category, status, criticality, zone_id, manufacturer, model, serial, commissioned_at, warranty_until, notes, source, created_by, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11,NULL,'demo','demo-seed','demo-seed',$12)`,
          [a.id, a.tag, a.name, a.category, a.status, a.criticality, a.zoneId, a.manufacturer, a.model, t - 900 * DAY_MS, t + 540 * DAY_MS, t],
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

const DAY_MS = 86_400_000;

function nodes(rows: AssetRow[]): AssetNode[] {
  return rows.map((r) => ({ id: r.id, status: r.status as AssetStatus, criticality: Number(r.criticality) }));
}

function assertEditable(row: AssetRow): void {
  if (row.status === 'retired') throw new AssetError('a retired asset is read-only', 409);
}

async function event(q: Queryable, assetId: string, kind: string, detail: Record<string, unknown>, actor: string, t: number): Promise<void> {
  await q.query('INSERT INTO asset_events (asset_id, t, kind, detail, actor) VALUES ($1, $2, $3, $4::jsonb, $5)', [assetId, t, kind, JSON.stringify(detail), actor]);
}
