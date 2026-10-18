/**
 * Asset and infrastructure register: the rules that follow from the records. The server stores assets, their
 * dependencies and maintenance plans; the functions here decide what follows from them (what a fault takes down,
 * whether a dependency would form a loop, when maintenance is due). They are pure, so the server, the browser and the
 * tests run the same rules.
 *
 * A dependency means "needs to be operating for this asset to work". An asset is `impaired` when it is itself working
 * but something it depends on, directly or through others, is out of service or retired. Only those two states
 * propagate; a degraded upstream asset is shown on its own and does not change what depends on it.
 */

export const ASSET_STATUSES = ['in_service', 'degraded', 'out_of_service', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
/** Statuses an operator may set. `retired` is reached only through the retirement workflow, which is final. */
export const SETTABLE_STATUSES = ['in_service', 'degraded', 'out_of_service'] as const;
export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

export const ASSET_CATEGORIES = ['power', 'comms', 'it', 'access', 'security', 'facilities', 'vehicle', 'other'] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const DEPENDENCY_KINDS = ['power', 'data', 'network', 'fuel', 'water', 'access', 'other'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/** Effective availability of an asset, derived from its own status and what it depends on. */
export const AVAILABILITY_STATES = ['available', 'degraded', 'impaired', 'down', 'retired'] as const;
export type Availability = (typeof AVAILABILITY_STATES)[number];

export interface AssetNode {
  id: string;
  status: AssetStatus;
  criticality: number;
}

/** `assetId` needs `dependsOnId` to operate. */
export interface DependencyEdge {
  assetId: string;
  dependsOnId: string;
  kind: DependencyKind;
}

export interface AssetAvailability {
  id: string;
  state: Availability;
  /** For `impaired`: the upstream assets that are out of service or retired. For `down`: empty (the fault is its own). */
  causes: string[];
}

export interface Dependent {
  id: string;
  /** 1 for a direct dependent, 2 for one that depends on a direct dependent, and so on (shortest path). */
  depth: number;
}

const adjacency = (edges: DependencyEdge[]) => {
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const e of edges) {
    up.set(e.assetId, [...(up.get(e.assetId) ?? []), e.dependsOnId]);
    down.set(e.dependsOnId, [...(down.get(e.dependsOnId) ?? []), e.assetId]);
  }
  return { up, down };
};

/** Every asset `id` depends on, directly or through others. Cycle-safe. */
export function upstreamOf(id: string, edges: DependencyEdge[]): Set<string> {
  const { up } = adjacency(edges);
  const seen = new Set<string>();
  const stack = [...(up.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(up.get(next) ?? []));
  }
  seen.delete(id);
  return seen;
}

/** Every asset that depends on `id`, directly or through others, with the shortest depth. Breadth-first and cycle-safe. */
export function dependentsOf(id: string, edges: DependencyEdge[]): Dependent[] {
  const { down } = adjacency(edges);
  const depth = new Map<string, number>();
  let frontier = [id];
  for (let d = 1; frontier.length; d++) {
    const next: string[] = [];
    for (const cur of frontier)
      for (const dep of down.get(cur) ?? []) {
        if (dep === id || depth.has(dep)) continue;
        depth.set(dep, d);
        next.push(dep);
      }
    frontier = next;
  }
  return [...depth].map(([assetId, d]) => ({ id: assetId, depth: d })).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
}

/**
 * True when giving `id` the dependencies `targets` would close a loop: a target that already depends on `id` (directly
 * or not), or `id` itself. `id`'s current outgoing edges are replaced, so they are ignored.
 */
export function wouldCycle(id: string, targets: string[], edges: DependencyEdge[]): boolean {
  if (targets.includes(id)) return true;
  const without = edges.filter((e) => e.assetId !== id);
  return targets.some((t) => upstreamOf(t, without).has(id));
}

/** Effective availability of every asset. A retired asset is `retired`; one with a retired or out-of-service upstream is `impaired`. */
export function availabilityOf(assets: AssetNode[], edges: DependencyEdge[]): Map<string, AssetAvailability> {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out = new Map<string, AssetAvailability>();
  for (const a of assets) {
    if (a.status === 'retired') {
      out.set(a.id, { id: a.id, state: 'retired', causes: [] });
      continue;
    }
    if (a.status === 'out_of_service') {
      out.set(a.id, { id: a.id, state: 'down', causes: [] });
      continue;
    }
    const causes = [...upstreamOf(a.id, edges)].filter((u) => {
      const s = byId.get(u)?.status;
      return s === 'out_of_service' || s === 'retired';
    });
    causes.sort();
    if (causes.length) out.set(a.id, { id: a.id, state: 'impaired', causes });
    else out.set(a.id, { id: a.id, state: a.status === 'degraded' ? 'degraded' : 'available', causes: [] });
  }
  return out;
}

export interface ImpactRow {
  id: string;
  depth: number;
  from: Availability;
  to: Availability;
  criticality: number;
}

/**
 * What would change if `id` moved to `status`: every other asset whose effective availability would change, nearest
 * first, then most critical first. Only dependents can change, so only they are compared.
 */
export function impactIf(id: string, status: AssetStatus, assets: AssetNode[], edges: DependencyEdge[]): ImpactRow[] {
  const before = availabilityOf(assets, edges);
  const after = availabilityOf(
    assets.map((a) => (a.id === id ? { ...a, status } : a)),
    edges,
  );
  const crit = new Map(assets.map((a) => [a.id, a.criticality]));
  const rows: ImpactRow[] = [];
  for (const d of dependentsOf(id, edges)) {
    const from = before.get(d.id)?.state;
    const to = after.get(d.id)?.state;
    if (!from || !to || from === to) continue;
    rows.push({ id: d.id, depth: d.depth, from, to, criticality: crit.get(d.id) ?? 0 });
  }
  return rows.sort((a, b) => b.criticality - a.criticality || a.depth - b.depth || a.id.localeCompare(b.id));
}

const DAY_MS = 86_400_000;
/** Maintenance falling due within this window is shown as due soon. */
export const MAINTENANCE_SOON_MS = 7 * DAY_MS;

export interface PlanState {
  state: 'never' | 'overdue' | 'due_soon' | 'ok';
  /** Epoch ms when the next service is due; null until the plan has been done once. */
  dueAt: number | null;
}

/** Due state of a recurring maintenance plan. A plan never done is `never` and is shown as needing a first record. */
export function planState(lastDoneAt: number | null, intervalDays: number, now: number): PlanState {
  if (lastDoneAt === null) return { state: 'never', dueAt: null };
  const dueAt = lastDoneAt + intervalDays * DAY_MS;
  if (dueAt <= now) return { state: 'overdue', dueAt };
  if (dueAt - now <= MAINTENANCE_SOON_MS) return { state: 'due_soon', dueAt };
  return { state: 'ok', dueAt };
}
