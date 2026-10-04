import { describe, expect, it } from 'vitest';
import { buildHandoff, can, FACILITY, parseIntent, type HandoffObservation } from '../src/index.ts';

const sig = [0.5, -0.2, 0.1, 0.3, -0.4, 0.2, 0.1, 0, 0.3, -0.1, 0.2, 0.1, -0.3, 0.2, 0.1, 0.2];
const near = (k: number) => sig.map((v, i) => v + 0.03 * Math.sin(k * 7 + i));

describe('hand-off', () => {
  it('builds a feasible chain with blind intervals and never claims certainty', () => {
    const t0 = 10_000_000;
    const obs: HandoffObservation[] = [
      { observationId: 'a', cameraId: 'C01', t: t0, position: { x: 10, y: 2300, z: 0 }, appearance: near(1), sharpness: 0.4, faceQuality: 0.2, sigmaM: 2 },
      { observationId: 'b', cameraId: 'C04', t: t0 + 1100_000, position: { x: 20, y: 380, z: 0 }, appearance: near(2), sharpness: 0.6, faceQuality: 0.3, sigmaM: 2 },
      // Impossible: 2 km in 20 s.
      { observationId: 'x', cameraId: 'C16', t: t0 + 1120_000, position: { x: -1300, y: -900, z: 0 }, appearance: near(3), sharpness: 0.9, faceQuality: 0.1, sigmaM: 3 },
      { observationId: 'c', cameraId: 'C07', t: t0 + 1500_000, position: { x: 0, y: -360, z: 0 }, appearance: near(4), sharpness: 0.9, faceQuality: 0.35, sigmaM: 2 },
    ];
    const r = buildHandoff(sig, obs);
    expect(r.links.map((l) => l.observation.cameraId)).toEqual(['C01', 'C04', 'C07']);
    expect(r.blindIntervals).toHaveLength(2);
    expect(r.blindIntervals[0]!.prism.length).toBeGreaterThan(10);
    expect(r.humanReviewRequired).toBe(true);
    expect(r.faceEvidence).toBe('LOW');
    expect(['PROBABLE', 'POSSIBLE']).toContain(r.identityState);
  });
});

describe('copilot intent parser', () => {
  it('parses the reference questions', () => {
    expect(parseIntent('What changed around Building C during the last hour?', FACILITY)).toMatchObject({ intent: 'changes_near', subject: { id: 'bld-C' }, windowMin: 60 });
    expect(parseIntent('Show every sensor supporting Track A-148.', FACILITY)).toMatchObject({ intent: 'track_sensors', trackId: 'A-148' });
    expect(parseIntent('Take me to the last confirmed observation.', FACILITY, { selectedTrackId: 'P-104' })).toMatchObject({ intent: 'goto_last_confirmed', trackId: 'P-104' });
    expect(parseIntent('Compare the facility at 13:00 and 15:00.', FACILITY)).toMatchObject({ intent: 'compare_times', a: { kind: 'clock', h: 13 }, b: { kind: 'clock', h: 15 } });
    expect(parseIntent('Which regions currently have the lowest observation confidence?', FACILITY)).toMatchObject({ intent: 'lowest_confidence' });
    expect(parseIntent('What evidence supports this reconstruction?', FACILITY)).toMatchObject({ intent: 'evidence_for' });
    expect(parseIntent('Which sensors stopped reporting before this incident?', FACILITY, { incidentId: 'INC-2026-014' })).toMatchObject({ intent: 'sensors_stopped_before', incidentId: 'INC-2026-014' });
  });
});

describe('rbac', () => {
  it('gates sensitive demonstration functions', () => {
    expect(can('viewer', 'handoff.search')).toBe(false);
    expect(can('operator', 'handoff.search')).toBe(false);
    expect(can('analyst', 'handoff.search')).toBe(true);
    expect(can('analyst', 'admin.users')).toBe(false);
  });
});
