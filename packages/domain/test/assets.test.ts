import { describe, expect, it } from 'vitest';
import {
  availabilityOf,
  dependentsOf,
  impactIf,
  planState,
  upstreamOf,
  wouldCycle,
  type AssetNode,
  type DependencyEdge,
  MAINTENANCE_SOON_MS,
} from '../src/assets/model.ts';

const node = (id: string, status: AssetNode['status'] = 'in_service', criticality = 3): AssetNode => ({ id, status, criticality });
const edge = (assetId: string, dependsOnId: string): DependencyEdge => ({ assetId, dependsOnId, kind: 'power' });

// MAINS -> UPS -> SWITCH -> NVR ; UPS -> PIDS ; SWITCH -> PIDS ; LIGHT -> MAINS
const assets = [node('MAINS', 'in_service', 5), node('UPS', 'in_service', 5), node('SWITCH', 'in_service', 5), node('NVR', 'in_service', 4), node('PIDS', 'in_service', 5), node('LIGHT', 'in_service', 2), node('LONE')];
const edges = [edge('UPS', 'MAINS'), edge('SWITCH', 'UPS'), edge('NVR', 'SWITCH'), edge('PIDS', 'UPS'), edge('PIDS', 'SWITCH'), edge('LIGHT', 'MAINS')];

describe('dependency closure', () => {
  it('upstream follows every path and never includes the asset itself', () => {
    expect([...upstreamOf('NVR', edges)].sort()).toEqual(['MAINS', 'SWITCH', 'UPS']);
    expect(upstreamOf('LONE', edges).size).toBe(0);
  });

  it('dependents report the shortest depth, nearest first, ties by id', () => {
    expect(dependentsOf('MAINS', edges)).toEqual([
      { id: 'LIGHT', depth: 1 },
      { id: 'UPS', depth: 1 },
      { id: 'PIDS', depth: 2 },
      { id: 'SWITCH', depth: 2 },
      { id: 'NVR', depth: 3 },
    ]);
  });

  it('closure terminates on a graph that already contains a loop', () => {
    const loop = [edge('A', 'B'), edge('B', 'A')];
    expect([...upstreamOf('A', loop)]).toEqual(['B']);
    expect(dependentsOf('A', loop)).toEqual([{ id: 'B', depth: 1 }]);
  });
});

describe('dependency loops', () => {
  it('refuses a self-dependency', () => {
    expect(wouldCycle('UPS', ['UPS'], edges)).toBe(true);
  });

  it('refuses a dependency on something that already depends on the asset, directly or not', () => {
    expect(wouldCycle('MAINS', ['NVR'], edges)).toBe(true);
    expect(wouldCycle('UPS', ['PIDS'], edges)).toBe(true);
  });

  it('allows a dependency that keeps the graph acyclic', () => {
    expect(wouldCycle('LONE', ['MAINS', 'UPS'], edges)).toBe(false);
    expect(wouldCycle('LIGHT', ['UPS'], edges)).toBe(false);
  });

  it('replacing an asset’s own edges is not counted against it', () => {
    // UPS currently depends on MAINS. Replacing that with nothing is fine even though MAINS sits upstream.
    expect(wouldCycle('UPS', [], edges)).toBe(false);
  });
});

describe('effective availability', () => {
  it('every asset is available when nothing is out of service', () => {
    const av = availabilityOf(assets, edges);
    expect([...av.values()].every((a) => a.state === 'available')).toBe(true);
  });

  it('an out-of-service asset is down with no causes (the fault is its own)', () => {
    const av = availabilityOf(assets.map((a) => (a.id === 'UPS' ? { ...a, status: 'out_of_service' as const } : a)), edges);
    expect(av.get('UPS')).toEqual({ id: 'UPS', state: 'down', causes: [] });
  });

  it('a working asset with an out-of-service upstream is impaired, and the causes are the nearest faults', () => {
    const av = availabilityOf(assets.map((a) => (a.id === 'MAINS' ? { ...a, status: 'out_of_service' as const } : a)), edges);
    expect(av.get('NVR')).toEqual({ id: 'NVR', state: 'impaired', causes: ['MAINS'] });
    expect(av.get('LIGHT')).toEqual({ id: 'LIGHT', state: 'impaired', causes: ['MAINS'] });
  });

  it('a retired upstream impairs its dependents, and a retired asset is retired', () => {
    const av = availabilityOf(assets.map((a) => (a.id === 'SWITCH' ? { ...a, status: 'retired' as const } : a)), edges);
    expect(av.get('SWITCH')?.state).toBe('retired');
    expect(av.get('NVR')?.state).toBe('impaired');
    expect(av.get('NVR')?.causes).toEqual(['SWITCH']);
  });

  it('a degraded upstream is shown on its own and does not change what depends on it', () => {
    const av = availabilityOf(assets.map((a) => (a.id === 'UPS' ? { ...a, status: 'degraded' as const } : a)), edges);
    expect(av.get('UPS')?.state).toBe('degraded');
    expect(av.get('SWITCH')?.state).toBe('available');
  });
});

describe('hypothetical impact', () => {
  it('lists only the assets whose state would change, most critical first, then nearest, then by id', () => {
    const rows = impactIf('UPS', 'out_of_service', assets, edges);
    expect(rows.map((r) => r.id)).toEqual(['PIDS', 'SWITCH', 'NVR']);
    expect(rows[0]).toEqual({ id: 'PIDS', depth: 1, from: 'available', to: 'impaired', criticality: 5 });
    expect(rows.some((r) => r.id === 'LIGHT' || r.id === 'MAINS')).toBe(false);
  });

  it('a fault that nothing depends on changes nothing else', () => {
    expect(impactIf('LONE', 'out_of_service', assets, edges)).toEqual([]);
  });

  it('does not mutate the register it was given', () => {
    const before = JSON.stringify(assets);
    impactIf('MAINS', 'out_of_service', assets, edges);
    expect(JSON.stringify(assets)).toBe(before);
  });
});

describe('maintenance due state', () => {
  const DAY = 86_400_000;
  const now = 1_000 * DAY;

  it('a plan never done asks for a first record and has no due date', () => {
    expect(planState(null, 90, now)).toEqual({ state: 'never', dueAt: null });
  });

  it('overdue once the interval has passed, due soon inside the window, otherwise ok', () => {
    expect(planState(now - 91 * DAY, 90, now).state).toBe('overdue');
    expect(planState(now - 90 * DAY, 90, now).state).toBe('overdue');
    expect(planState(now - 90 * DAY + MAINTENANCE_SOON_MS - 1, 90, now).state).toBe('due_soon');
    expect(planState(now - 30 * DAY, 90, now)).toEqual({ state: 'ok', dueAt: now + 60 * DAY });
  });
});
