import { describe, expect, it } from 'vitest';
import { assess, threatBoard, type VitalAsset } from '../src/ops/threat.ts';
import type { TrackSnapshot } from '../src/schemas/model.ts';

const va: VitalAsset = { id: 'va-ammo', name: 'Ammunition point', kind: 'ammunition', priority: 1, centre: { x: 0, y: 0 }, radiusM: 100, zoneId: null };
const track = (p: Partial<TrackSnapshot>): TrackSnapshot => ({
  id: 'A-1', category: 'aerial', label: 'A-1', status: 'confirmed', t: 0, position: { x: 1100, y: 0, z: 80 }, velocity: { x: -20, y: 0, z: 0 }, sigmaH: 10, sigmaV: 5, confidence: 0.9,
  contributors: ['R01'], lastConfirmedAt: 0, lastConfirmedPosition: { x: 1100, y: 0, z: 80 }, entityId: null, cooperative: false, classification: 'drone', state: 'CAPTURED', hits: 10, ...p,
});

describe('threat evaluation', () => {
  it('computes time-to-boundary, CPA and closing speed for an inbound track', () => {
    const a = assess(track({}), va);
    expect(a.rangeM).toBe(1000);
    expect(a.timeToBoundaryS).toBe(50);
    expect(a.closingMps).toBe(20);
    expect(a.cpaM).toBe(0);
    expect(a.level).toBe('HIGH');
  });

  it('a crossing track that misses the asset has no time-to-boundary and a larger CPA', () => {
    const a = assess(track({ position: { x: -1000, y: 300, z: 80 }, velocity: { x: 20, y: 0, z: 0 } }), va);
    expect(a.timeToBoundaryS).toBeNull();
    expect(a.cpaM).toBe(200);
    expect(a.tcpaS).toBe(50);
  });

  it('ranks inbound above outbound, excludes cooperative tracks and scores birds zero', () => {
    const board = threatBoard(
      [
        track({ id: 'IN' }),
        track({ id: 'OUT', velocity: { x: 20, y: 0, z: 0 } }),
        track({ id: 'OWN', cooperative: true }),
        track({ id: 'BIRD', classification: 'bird' }),
      ],
      [va],
    );
    expect(board.map((b) => b.trackId)).toEqual(['IN', 'OUT']);
    expect(board[0]!.score).toBeGreaterThan(board[1]!.score);
  });

  it('a person inside the asset is critical', () => {
    const a = assess(track({ category: 'person', classification: 'person', position: { x: 20, y: 10, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }), va);
    expect(a.inside).toBe(true);
    expect(a.level).toBe('CRITICAL');
  });
});

describe('lost tracks', () => {
  it('are discounted below live contacts, even inside a boundary', () => {
    const va: VitalAsset = { id: 'va-x', name: 'Armoury', kind: 'ammunition', priority: 1, centre: { x: 0, y: 0 }, radiusM: 50, zoneId: null };
    const base = { id: 'P-1', category: 'person' as const, label: 'P-1', t: 0, position: { x: 10, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, sigmaH: 2, sigmaV: 1, confidence: 0.9, contributors: ['C1'], lastConfirmedAt: 0, lastConfirmedPosition: { x: 10, y: 0, z: 0 }, entityId: null, cooperative: false, classification: 'person' as const, state: 'RECONSTRUCTED' as const, hits: 10 };
    const live = assess({ ...base, status: 'confirmed' }, va);
    const lost = assess({ ...base, status: 'lost', state: 'INFERRED' }, va);
    expect(live.level).toBe('CRITICAL');
    expect(lost.score).toBeLessThan(live.score / 2);
    expect(lost.level).not.toBe('CRITICAL');
    expect(lost.factors.map((f) => f.name)).toContain('lost (last known position)');
  });
});
