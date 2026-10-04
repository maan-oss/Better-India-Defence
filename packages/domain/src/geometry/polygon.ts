import type { Vec2 } from '../math/vec.ts';

/** Even–odd point-in-polygon test. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Proper intersection of segments p1→p2 and p3→p4; returns the intersection point or null. */
export function segmentIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

export function distancePointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

export function polylineLength(points: Vec2[], closed = false): number {
  let l = 0;
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    l += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return l;
}

/** Point and tangent at arc-length s along a polyline (wraps when closed, clamps otherwise). */
export function pointAlong(points: Vec2[], s: number, closed = false): { p: Vec2; heading: number } {
  const total = polylineLength(points, closed);
  let rem = closed ? ((s % total) + total) % total : Math.max(0, Math.min(total, s));
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (rem <= seg || i === n - 1) {
      const t = seg > 0 ? Math.min(1, rem / seg) : 0;
      return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, heading: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    rem -= seg;
  }
  const last = points[points.length - 1]!;
  return { p: { ...last }, heading: 0 };
}
