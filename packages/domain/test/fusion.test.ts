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
