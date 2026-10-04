import { PNG } from 'pngjs';
import { boxFootprint, gaussianAt, hashString, pointInPolygon, type SolidBox } from '@strata/domain';
import { groundColor, groundShade, sunDirection, type RGB } from './ground.ts';
import type { TruthWorld } from '../truth/world.ts';

const ROOF: Record<SolidBox['material'], RGB> = {
  concrete: [186, 182, 174],
  metal: [160, 168, 172],
  glass: [100, 110, 120],
  vehicle: [70, 74, 80],
  person: [90, 80, 70],
  drone: [40, 40, 40],
  debris: [140, 128, 110],
  container: [160, 96, 62],
  tank: [214, 214, 208],
};

/**
 * Orthographic nadir rendering of simulator truth — the synthetic satellite's sensor model.
 * Ground sample distance is fixed by the satellite definition; people are sub-pixel and invisible,
 * vehicles are 1–2 px. That limitation is intentional: it is what real EO imagery at this GSD shows.
 */
export function renderOrtho(world: TruthWorld, t: number, gsdM: number, halfExtentM: number): { png: Uint8Array; width: number; height: number; rgba: Uint8Array } {
  const N = Math.round((2 * halfExtentM) / gsdM);
  const png = new PNG({ width: N, height: N });
  const sun = sunDirection(t);
  const rgba = png.data;
  const toWorld = (px: number, py: number) => ({ x: -halfExtentM + (px + 0.5) * gsdM, y: halfExtentM - (py + 0.5) * gsdM });
  for (let py = 0; py < N; py++)
    for (let px = 0; px < N; px++) {
      const w = toWorld(px, py);
      const c = groundColor(w.x, w.y);
      const s = groundShade(w.x, w.y, sun);
      const i = (py * N + px) * 4;
      rgba[i] = c[0] * s;
      rgba[i + 1] = c[1] * s;
      rgba[i + 2] = c[2] * s;
      rgba[i + 3] = 255;
    }
  const boxes = [...world.staticBoxes(t), ...world.entityBoxes(t).filter((b) => b.material === 'vehicle')].sort((a, b) => a.z0 + a.height - (b.z0 + b.height));
  const shadowLen = 1 / Math.tan(Math.asin(sun.z));
  const fill = (poly: { x: number; y: number }[], f: (i: number) => void) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of poly) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    const pxa = Math.max(0, Math.floor((x0 + halfExtentM) / gsdM));
    const pxb = Math.min(N - 1, Math.ceil((x1 + halfExtentM) / gsdM));
    const pya = Math.max(0, Math.floor((halfExtentM - y1) / gsdM));
    const pyb = Math.min(N - 1, Math.ceil((halfExtentM - y0) / gsdM));
    for (let py = pya; py <= pyb; py++)
      for (let px = pxa; px <= pxb; px++) if (pointInPolygon(toWorld(px, py), poly)) f((py * N + px) * 4);
  };
  for (const b of boxes) {
    const fp = boxFootprint(b);
    const off = { x: -sun.x * shadowLen * b.height, y: -sun.y * shadowLen * b.height };
    const shadow = [...fp, ...fp.map((p) => ({ x: p.x + off.x, y: p.y + off.y }))];
    // Convex hull of footprint ∪ shifted footprint approximated by the shifted quad union.
    const hull = convexHull(shadow);
    fill(hull, (i) => {
      rgba[i] = rgba[i]! * 0.55;
      rgba[i + 1] = rgba[i + 1]! * 0.55;
      rgba[i + 2] = rgba[i + 2]! * 0.6;
    });
  }
  for (const b of boxes) {
    const c = ROOF[b.material];
    const k = 0.9 + Math.min(0.15, b.height / 200);
    fill(boxFootprint(b), (i) => {
      rgba[i] = c[0] * k;
      rgba[i + 1] = c[1] * k;
      rgba[i + 2] = c[2] * k;
    });
  }
  const seed = hashString(`sat:${t}`);
  for (let i = 0; i < N * N; i++) {
    const n = gaussianAt(seed, i) * 1.5;
    rgba[i * 4] = Math.max(0, Math.min(255, rgba[i * 4]! + n));
    rgba[i * 4 + 1] = Math.max(0, Math.min(255, rgba[i * 4 + 1]! + n));
    rgba[i * 4 + 2] = Math.max(0, Math.min(255, rgba[i * 4 + 2]! + n));
  }
  const buf = PNG.sync.write(png);
  return { png: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), width: N, height: N, rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) };
}

function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
