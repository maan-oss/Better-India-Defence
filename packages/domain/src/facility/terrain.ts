import { hash01 } from '../random.ts';

/**
 * Deterministic synthetic terrain. The operational core (airfield + compound) is flattened to z = 0;
 * outlying ground undulates with low-amplitude fractal noise plus a ridge in the north-west.
 * This is a synthetic DEM — a real deployment would load a surveyed DTM (GeoTIFF / quantized-mesh).
 */
const TERRAIN_SEED = 7331;

interface FlatRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Areas graded flat (z = 0). Margins blend smoothly over FLAT_BLEND metres. */
export const FLAT_AREAS: FlatRect[] = [
  { x0: -1450, y0: -1050, x1: 1850, y1: 950 },
  { x0: -1700, y0: 950, x1: -300, y1: 1700 },
  { x0: 300, y0: 950, x1: 1650, y1: 1450 },
  { x0: -60, y0: 950, x1: 60, y1: 2480 },
  { x0: 950, y0: -60, x1: 2480, y1: 60 },
  { x0: 1600, y0: -1400, x1: 1800, y1: -1050 },
];
const FLAT_BLEND = 220;

const smooth = (t: number): number => t * t * (3 - 2 * t);

function valueNoise(x: number, y: number, octaveSeed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const a = hash01(xi, yi, octaveSeed);
  const b = hash01(xi + 1, yi, octaveSeed);
  const c = hash01(xi, yi + 1, octaveSeed);
  const d = hash01(xi + 1, yi + 1, octaveSeed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function fbm(x: number, y: number): number {
  let amp = 1;
  let freq = 1 / 900;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += amp * (valueNoise(x * freq, y * freq, TERRAIN_SEED + o * 101) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

function flatMask(x: number, y: number): number {
  let best = 1;
  for (const r of FLAT_AREAS) {
    const dx = Math.max(r.x0 - x, 0, x - r.x1);
    const dy = Math.max(r.y0 - y, 0, y - r.y1);
    const d = Math.hypot(dx, dy);
    const m = d >= FLAT_BLEND ? 1 : smooth(d / FLAT_BLEND);
    if (m < best) best = m;
  }
  return best;
}

/** Terrain elevation (m) at local ENU (x, y). Pure and deterministic. */
export function terrainHeight(x: number, y: number): number {
  const mask = flatMask(x, y);
  if (mask <= 0) return 0;
  const ridgeD = Math.hypot(x + 1900, y - 400) / 700;
  const ridge = 22 * Math.exp(-ridgeD * ridgeD);
  return mask * (9 * fbm(x, y) + ridge);
}

/** Approximate surface normal via central differences. */
export function terrainNormal(x: number, y: number): { x: number; y: number; z: number } {
  const e = 2;
  const dzdx = (terrainHeight(x + e, y) - terrainHeight(x - e, y)) / (2 * e);
  const dzdy = (terrainHeight(x, y + e) - terrainHeight(x, y - e)) / (2 * e);
  const l = Math.hypot(dzdx, dzdy, 1);
  return { x: -dzdx / l, y: -dzdy / l, z: 1 / l };
}
