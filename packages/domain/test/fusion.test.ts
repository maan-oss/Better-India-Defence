import { describe, expect, it } from 'vitest';
import { TrackEngine, type TrackMeasurement } from '../src/index.ts';

const radar = (sensorId: string, localId: string, t: number, x: number, y: number, z: number, vx = 10): TrackMeasurement => ({
  observationId: `${sensorId}-${t}-${localId}`,
  sensorId,
  sensorKind: 'radar',
  localId,
  t,
  position: { x, y, z },
  sigma: { x: 12, y: 12, z: 20 },
  velocity: { x: vx, y: 0, z: 0 },
  cls: 'unknown',
  confidence: 0.9,
  positional: true,
});

describe('TrackEngine', () => {
  it('fuses two radars observing one aerial object into a single track', () => {
    const e = new TrackEngine();
    for (let k = 0; k < 10; k++) {
      const t = 1_000_000 + k * 2000;
      const x = k * 20;
      e.ingest([radar('R01', '7', t, x + 3, 5, 120), radar('R02', '31', t + 100, x - 4, -6, 118)]);
      e.tick(t + 200);
    }
    const tracks = e.snapshots(1_020_000);
    expect(tracks).toHaveLength(1);
    const tr = tracks[0]!;
    expect(tr.id).toMatch(/^A-\d+$/);
    expect(tr.contributors).toEqual(['R01', 'R02']);
    expect(tr.status).toBe('confirmed');
    expect(Math.abs(tr.velocity.x - 10)).toBeLessThan(2);
  });

  it('keeps separated objects as separate tracks', () => {
    const e = new TrackEngine();
    for (let k = 0; k < 6; k++) {
      const t = 2_000_000 + k * 2000;
      e.ingest([radar('R01', '1', t, k * 20, 0, 100), radar('R01', '2', t, k * 20, 800, 100)]);
      e.tick(t);
    }
    expect(e.snapshots(2_012_000)).toHaveLength(2);
  });

  it('attaches RF region and camera bearing as evidence without moving the estimate', () => {
    const e = new TrackEngine();
    for (let k = 0; k < 4; k++) e.ingest([radar('R01', '9', 3_000_000 + k * 2000, 1000 + k * 20, 1000, 120)]);
    const before = e.snapshots(3_006_000)[0]!;
    e.ingest([
      {
        observationId: 'rf-1',
        sensorId: 'RF03',
        sensorKind: 'rf',
        localId: 'e1',
        t: 3_006_000,
        position: { x: 1100, y: 1050, z: 0 },
        sigma: { x: 150, y: 150, z: 500 },
        cls: 'drone',
        confidence: 0.8,
        positional: false,
        regionRadiusM: 250,
      },
      {
        observationId: 'cam-1',
        sensorId: 'C13',
        sensorKind: 'camera',
        localId: 'c1',
        t: 3_006_000,
        position: { x: 0, y: 0, z: 0 },
        sigma: { x: 1, y: 1, z: 1 },
        cls: 'drone',
        confidence: 0.9,
        positional: false,
        ray: { origin: { x: 1000, y: 800, z: 10 }, dir: normalize({ x: 80, y: 200, z: 110 }) },
      },
    ]);
    const after = e.snapshots(3_006_000)[0]!;
    expect(after.contributors).toEqual(['C13', 'R01', 'RF03']);
    expect(after.position.x).toBeCloseTo(before.position.x, 6);
    expect(after.classification).toBe('drone');
  });

  it('holds the last confirmed position after loss of contact and grows the possible region', () => {
    const e = new TrackEngine();
    for (let k = 0; k < 5; k++)
      e.ingest([
        {
          observationId: `c-${k}`,
          sensorId: 'C04',
          sensorKind: 'camera',
          localId: 'p1',
          t: 4_000_000 + k * 1000,
          position: { x: 100 + k * 1.4, y: 200, z: 0 },
          sigma: { x: 1.5, y: 1.5, z: 3 },
          cls: 'person',
          confidence: 0.9,
          positional: true,
        },
      ]);
    e.tick(4_060_000);
    const s = e.snapshots(4_060_000)[0]!;
    expect(s.status).toBe('lost');
    expect(s.state).toBe('INFERRED');
    expect(s.position.x).toBeCloseTo(s.lastConfirmedPosition.x, 6);
    expect(s.sigmaH).toBeGreaterThan(100); // ~56 s × 3 m/s
  });
});

function normalize(v: { x: number; y: number; z: number }) {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

describe('TrackEngine with sparse reports', () => {
  const report = (k: number, t: number, validUntil?: number): TrackMeasurement => ({
    observationId: `ext-${k}`,
    sensorId: 'EXT1',
    sensorKind: 'external',
    localId: 'BRAVO2',
    t,
    position: { x: 8 * (t / 1000), y: 0, z: 0 },
    sigma: { x: 6, y: 6, z: 2 },
    cls: 'cooperative',
    entityId: 'TAK:BRAVO2',
    label: 'BRAVO-2',
    confidence: 0.95,
    positional: true,
    category: 'person',
    ...(validUntil ? { validUntil } : {}),
  });

  it('keeps the velocity estimate honest when the clock ticks between reports', () => {
    const e = new TrackEngine();
    for (let k = 0; k < 12; k++) {
      const t = k * 10_000;
      e.ingest([report(k, t)]);
      // Wall-clock ticks between the 10 s reports must not distort the next update's time step.
      for (let s = 1; s < 10; s++) e.tick(t + s * 1000);
    }
    const s = e.snapshots(110_000)[0]!;
    expect(Math.hypot(s.velocity.x, s.velocity.y)).toBeGreaterThan(6.5);
    expect(Math.hypot(s.velocity.x, s.velocity.y)).toBeLessThan(9.5);
  });

  it('honours the source-declared validity (CoT stale) before coasting, up to a cap', () => {
    const e = new TrackEngine();
    for (let k = 0; k < 4; k++) e.ingest([report(k, k * 10_000, k * 10_000 + 30_000)]);
    e.tick(38_000); // 8 s after the last report: a person track would coast after 4 s without a validity
    expect(e.snapshots(38_000)[0]!.status).toBe('confirmed');
    e.tick(65_000); // past the stale time
    expect(e.snapshots(65_000)[0]!.status).toBe('coasting');
    const f = new TrackEngine();
    for (let k = 0; k < 4; k++) f.ingest([report(k, k * 10_000, k * 10_000 + 3_600_000)]);
    f.tick(30_000 + 61_000); // an hour's claimed validity is capped at 60 s
    expect(f.snapshots(91_000)[0]!.status).toBe('coasting');
  });
});
