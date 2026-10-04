import { describe, expect, it } from 'vitest';
import { EnuFrame, ecefToGeodetic, geodeticToEcef } from '../src/index.ts';

describe('geodesy', () => {
  it('round-trips geodetic ↔ ECEF to sub-millimetre', () => {
    for (const g of [
      { lat: 0, lon: 0, alt: 0 },
      { lat: 28.6, lon: 77.2, alt: 216 },
      { lat: -33.9, lon: 151.2, alt: 58 },
      { lat: 64.1, lon: -21.9, alt: 10 },
    ]) {
      const back = ecefToGeodetic(geodeticToEcef(g));
      expect(back.lat).toBeCloseTo(g.lat, 9);
      expect(back.lon).toBeCloseTo(g.lon, 9);
      expect(back.alt).toBeCloseTo(g.alt, 3);
    }
  });

  it('ENU frame maps metres consistently across a 5 km site', () => {
    const f = new EnuFrame({ lat: 12.5, lon: 45.25, alt: 100 });
    for (const p of [
      { x: 0, y: 0, z: 0 },
      { x: 2500, y: -2500, z: 30 },
      { x: -1234.5, y: 987.6, z: 120 },
    ]) {
      const e = f.toEnu(f.toGeodetic(p));
      expect(e.x).toBeCloseTo(p.x, 3);
      expect(e.y).toBeCloseTo(p.y, 3);
      expect(e.z).toBeCloseTo(p.z, 3);
    }
    // 1 km north ≈ 0.009° latitude.
    const north = f.toGeodetic({ x: 0, y: 1000, z: 0 });
    expect(north.lat - 12.5).toBeGreaterThan(0.0089);
    expect(north.lat - 12.5).toBeLessThan(0.0091);
  });
});
