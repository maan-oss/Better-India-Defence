import { FACILITY, hash01, terrainHeight, type RoadDef } from '@strata/domain';

/**
 * Ground appearance model shared by the perspective (CCTV / drone) renderer and the orthographic
 * (satellite) renderer, so every imaging sensor sees the same synthetic surface.
 */
export type RGB = [number, number, number];

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  hw: number;
  surface: RoadDef['surface'];
  len: number;
  ux: number;
  uy: number;
}

const CELL = 50;
const segGrid = new Map<number, Seg[]>();
const key = (cx: number, cy: number) => (cx + 1000) * 4096 + (cy + 1000);

for (const r of FACILITY.roads) {
  const n = r.closed ? r.points.length : r.points.length - 1;
  for (let i = 0; i < n; i++) {
    const a = r.points[i]!;
    const b = r.points[(i + 1) % r.points.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const seg: Seg = { ax: a.x, ay: a.y, bx: b.x, by: b.y, hw: r.width / 2, surface: r.surface, len, ux: (b.x - a.x) / len, uy: (b.y - a.y) / len };
    const x0 = Math.floor((Math.min(a.x, b.x) - seg.hw) / CELL);
    const x1 = Math.floor((Math.max(a.x, b.x) + seg.hw) / CELL);
    const y0 = Math.floor((Math.min(a.y, b.y) - seg.hw) / CELL);
    const y1 = Math.floor((Math.max(a.y, b.y) + seg.hw) / CELL);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        const arr = segGrid.get(k);
        if (arr) arr.push(seg);
        else segGrid.set(k, [seg]);
      }
  }
}

const SURFACE_PRIORITY: Record<RoadDef['surface'], number> = { runway: 5, taxiway: 4, apron: 3, asphalt: 2, gravel: 1 };

function surfaceAt(x: number, y: number): { seg: Seg; along: number; perp: number } | null {
  const arr = segGrid.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (!arr) return null;
  let best: { seg: Seg; along: number; perp: number } | null = null;
  for (const s of arr) {
    const along = (x - s.ax) * s.ux + (y - s.ay) * s.uy;
    if (along < -s.hw || along > s.len + s.hw) continue;
    const perp = (x - s.ax) * -s.uy + (y - s.ay) * s.ux;
    if (Math.abs(perp) > s.hw) continue;
    if (!best || SURFACE_PRIORITY[s.surface] > SURFACE_PRIORITY[best.seg.surface]) best = { seg: s, along, perp };
  }
  return best;
}

/** Render-side terrain cache (5 m grid, bilinear). Rendering only — analysis code uses the exact model. */
const HC = 5;
const HN = Math.ceil((2 * 2700) / HC) + 2;
const heightGrid = new Float32Array(HN * HN).fill(Number.NaN);
function gridH(i: number, j: number): number {
  const k = j * HN + i;
  let v = heightGrid[k]!;
  if (Number.isNaN(v)) {
    v = terrainHeight(i * HC - 2700, j * HC - 2700);
    heightGrid[k] = v;
  }
  return v;
}
export function cachedHeight(x: number, y: number): number {
  const fx = (x + 2700) / HC;
  const fy = (y + 2700) / HC;
  const i = Math.max(0, Math.min(HN - 2, Math.floor(fx)));
  const j = Math.max(0, Math.min(HN - 2, Math.floor(fy)));
  const u = fx - i;
  const v = fy - j;
  return gridH(i, j) * (1 - u) * (1 - v) + gridH(i + 1, j) * u * (1 - v) + gridH(i, j + 1) * (1 - u) * v + gridH(i + 1, j + 1) * u * v;
}
function cachedNormal(x: number, y: number): { x: number; y: number; z: number } {
  const dzdx = (cachedHeight(x + HC, y) - cachedHeight(x - HC, y)) / (2 * HC);
  const dzdy = (cachedHeight(x, y + HC) - cachedHeight(x, y - HC)) / (2 * HC);
  const l = Math.hypot(dzdx, dzdy, 1);
  return { x: -dzdx / l, y: -dzdy / l, z: 1 / l };
}

/** Smooth value noise in [0,1]. */
function vnoise(x: number, y: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const xi = Math.floor(fx);
  const yi = Math.floor(fy);
  const u = fx - xi;
  const v = fy - yi;
  const su = u * u * (3 - 2 * u);
  const sv = v * v * (3 - 2 * v);
  const a = hash01(xi, yi, seed);
  const b = hash01(xi + 1, yi, seed);
  const c = hash01(xi, yi + 1, seed);
  const d = hash01(xi + 1, yi + 1, seed);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

const lerp3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const SCRUB: RGB = [150, 140, 112];
const SCRUB_DARK: RGB = [112, 110, 84];

/** Ground albedo at (x, y). Deterministic. */
export function groundColor(x: number, y: number): RGB {
  const hit = surfaceAt(x, y);
  const n = hash01(Math.floor(x / 2), Math.floor(y / 2), 17) * 0.35 + vnoise(x, y, 9, 23) * 0.65;
  if (hit) {
    const { seg, along, perp } = hit;
    switch (seg.surface) {
      case 'runway': {
        const centre = Math.abs(perp) < 0.45 && Math.floor(along / 30) % 2 === 0;
        const edge = Math.abs(Math.abs(perp) - (seg.hw - 1.5)) < 0.45;
        const threshold = (along < 60 || along > seg.len - 60) && Math.abs(perp) < seg.hw - 3 && Math.floor((perp + seg.hw) / 1.8) % 2 === 0;
        if (centre || edge || threshold) return [214, 212, 205];
        return lerp3([58, 58, 60], [68, 67, 66], n);
      }
      case 'taxiway': {
        if (Math.abs(perp) < 0.3) return [196, 160, 52];
        return lerp3([92, 91, 88], [104, 102, 98], n);
      }
      case 'apron':
        return lerp3([128, 126, 120], [140, 138, 132], n);
      case 'asphalt':
        if (Math.abs(perp) < 0.12 && Math.floor(along / 6) % 2 === 0) return [200, 198, 190];
        return lerp3([66, 66, 66], [76, 75, 73], n);
      case 'gravel':
        return lerp3([138, 128, 108], [152, 142, 120], n);
    }
  }
  const base = lerp3(SCRUB, SCRUB_DARK, vnoise(x, y, 140, 31) * 0.45 + vnoise(x, y, 35, 37) * 0.3 + n * 0.25);
  // Subtle relief tint so terrain reads in imagery.
  const h = cachedHeight(x, y);
  return lerp3(base, [128, 122, 96], Math.min(1, Math.max(0, h / 30)));
}

/** Fixed synthetic daylight. The simulator does not model diurnal illumination (documented limitation). */
export function sunDirection(t: number): { x: number; y: number; z: number } {
  const dayFrac = (t % 86_400_000) / 86_400_000;
  const az = ((140 + 20 * Math.sin(dayFrac * 2 * Math.PI)) * Math.PI) / 180; // compass
  const el = (52 * Math.PI) / 180;
  return { x: Math.cos(el) * Math.sin(az), y: Math.cos(el) * Math.cos(az), z: Math.sin(el) };
}

export function groundShade(x: number, y: number, sun: { x: number; y: number; z: number }): number {
  const n = cachedNormal(x, y);
  return 0.55 + 0.45 * Math.max(0, n.x * sun.x + n.y * sun.y + n.z * sun.z);
}
