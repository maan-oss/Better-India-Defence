import { describe, expect, it } from 'vitest';
import {
  BoxIndex,
  FACILITY,
  baselineBoxes,
  buildPatches,
  buildingBoxes,
  cameraPatchQuality,
  castScan,
  compareScan,
  findBuilding,
  getCameras,
  getLidars,
  summarizeSupport,
  type RangeScan,
} from '../src/index.ts';

describe('LiDAR ray-based change detection', () => {
  it('attributes a partial roof collapse to the right building', () => {
    const lidar = getLidars().find((l) => l.id === 'L01')!;
    const geom = {
      origin: lidar.position,
      azimuthSteps: 360,
      elevationSteps: 16,
      elevationMinDeg: lidar.elevationMinDeg,
      elevationMaxDeg: lidar.elevationMaxDeg,
      maxRangeM: lidar.rangeM,
    };
    const base = new BoxIndex(baselineBoxes(FACILITY));
    const expected = castScan(geom, base);
    const g = findBuilding('G')!;
    const damagedBoxes = baselineBoxes(FACILITY).filter((b) => b.ownerId !== g.id);
    damagedBoxes.push(
      ...buildingBoxes(g, [
        { id: 'G#w', fx0: 0, fx1: 0.55, height: 15 },
        { id: 'G#e', fx0: 0.55, fx1: 1, height: 5 },
      ]),
    );
    const measured = castScan(geom, new BoxIndex(damagedBoxes));
    const scan: RangeScan = { ...geom, sensorId: 'L01', scanId: 's1', t: 0, ranges: measured.ranges };
    const cmp = compareScan(scan, expected.ranges, expected.owners);
    expect(cmp.farther).toBeGreaterThan(20);
    const top = cmp.regions.find((r) => r.kind === 'farther');
    expect(top?.expectedOwner).toBe('bld-G');
  });
});

describe('coverage model', () => {
  it('a camera supports surfaces facing it and not hidden ones', () => {
    const index = new BoxIndex(baselineBoxes(FACILITY));
    const patches = buildPatches(FACILITY);
    const c12 = getCameras().find((c) => c.id === 'C12')!;
    const north = patches.filter((p) => p.ownerId === 'bld-C' && p.face === 'north');
    const south = patches.filter((p) => p.ownerId === 'bld-C' && p.face === 'south');
    expect(north.some((p) => cameraPatchQuality(c12, p, index) > 0.3)).toBe(true);
    expect(south.every((p) => cameraPatchQuality(c12, p, index) === 0)).toBe(true);
  });

  it('interiors are UNKNOWN and unobserved walls are PRIOR, never fabricated', () => {
    const patches = buildPatches(FACILITY);
    const room = patches.find((p) => p.id === 'bld-A-203:interior')!;
    expect(summarizeSupport(room, [], Date.now()).state).toBe('UNKNOWN');
    const wall = patches.find((p) => p.kind === 'wall')!;
    const s = summarizeSupport(wall, [], Date.now());
    expect(s.state).toBe('PRIOR');
    expect(s.overall).toBe(0);
  });
});
