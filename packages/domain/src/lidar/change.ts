import type { Vec3 } from '../math/vec.ts';
import { scanPoint, type RangeScan } from './scan.ts';

/**
 * Ray-based LiDAR change detection.
 *
 * For each ray we compare the measured range r_m with the range r_e expected from the platform's current
 * world model (not ground truth):
 *   r_m < r_e − τ  → something now occupies space that was free  ("closer": appeared / obstruction)
 *   r_m > r_e + τ  → an expected surface is no longer there      ("farther": removed / structural change)
 *   return lost    → expected surface missing with no new return ("farther")
 * Changed rays are clustered on a 2 m grid (8-connected) into change regions. Each region records the
 * expected owner (building / object id) of the surface it disagrees with, so it can be attributed.
 */
export interface LidarChangeRegion {
  kind: 'closer' | 'farther';
  points: number;
  centroid: Vec3;
  min: Vec3;
  max: Vec3;
  /** Most frequent expected-surface owner among the region's rays. */
  expectedOwner: string | null;
  meanDeltaM: number;
}

export interface LidarComparison {
  rays: number;
  returns: number;
  consistent: number;
  closer: number;
  farther: number;
  rmsResidualM: number;
  regions: LidarChangeRegion[];
  /** Residual statistics per expected owner, used for per-surface geometry support. */
  owners: Record<string, { rays: number; consistent: number; rms: number }>;
}

export function compareScan(scan: RangeScan, expected: Float32Array, expectedOwners: (string | null)[], tauM = 0.6, minPoints = 12): LidarComparison {
  const cell = 2;
  const buckets = new Map<string, { kind: 'closer' | 'farther'; pts: Vec3[]; owners: (string | null)[]; deltas: number[] }>();
  let returns = 0;
  let consistent = 0;
  let closer = 0;
  let farther = 0;
  let sq = 0;
  let nsq = 0;
  const ownerStats: Record<string, { rays: number; consistent: number; sq: number }> = {};
  for (let ei = 0; ei < scan.elevationSteps; ei++)
    for (let ai = 0; ai < scan.azimuthSteps; ai++) {
      const i = ei * scan.azimuthSteps + ai;
      const rm = scan.ranges[i]!;
      const re = expected[i]!;
      const owner = expectedOwners[i] ?? null;
      const hasM = Number.isFinite(rm);
      const hasE = Number.isFinite(re);
      if (hasM) returns++;
      if (!hasM && !hasE) continue;
      let kind: 'closer' | 'farther' | null = null;
      let p: Vec3 | null = null;
      let delta = 0;
      if (hasM && hasE) {
        delta = rm - re;
        if (delta < -tauM) {
          kind = 'closer';
          p = scanPoint(scan, ai, ei, rm);
        } else if (delta > tauM) {
          kind = 'farther';
          p = scanPoint(scan, ai, ei, re);
        } else {
          consistent++;
          sq += delta * delta;
          nsq++;
        }
      } else if (hasM && !hasE) {
        kind = 'closer';
        p = scanPoint(scan, ai, ei, rm);
        delta = -1;
      } else {
        kind = 'farther';
        p = scanPoint(scan, ai, ei, re);
        delta = 1;
      }
      if (owner) {
        const st = (ownerStats[owner] ??= { rays: 0, consistent: 0, sq: 0 });
        st.rays++;
        if (!kind) {
          st.consistent++;
          st.sq += delta * delta;
        }
      }
      if (!kind || !p) continue;
      if (kind === 'closer') closer++;
      else farther++;
      const key = `${kind}:${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
      const b = buckets.get(key) ?? { kind, pts: [], owners: [], deltas: [] };
      b.pts.push(p);
      b.owners.push(owner);
      b.deltas.push(delta);
      buckets.set(key, b);
    }
  // 8-connected clustering of occupied cells per kind.
  const seen = new Set<string>();
  const regions: LidarChangeRegion[] = [];
  for (const [key, b] of buckets) {
    if (seen.has(key)) continue;
    const queue = [key];
    seen.add(key);
    const pts: Vec3[] = [];
    const owners: (string | null)[] = [];
    const deltas: number[] = [];
    while (queue.length) {
      const k = queue.pop()!;
      const bb = buckets.get(k)!;
      pts.push(...bb.pts);
      owners.push(...bb.owners);
      deltas.push(...bb.deltas);
      const [, sx, sy] = k.split(':');
      const cx = Number(sx);
      const cy = Number(sy);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const nk = `${b.kind}:${cx + dx}:${cy + dy}`;
          if (!seen.has(nk) && buckets.has(nk)) {
            seen.add(nk);
            queue.push(nk);
          }
        }
    }
    if (pts.length < minPoints) continue;
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    const c = { x: 0, y: 0, z: 0 };
    for (const p of pts) {
      c.x += p.x;
      c.y += p.y;
      c.z += p.z;
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, p.y);
      min.z = Math.min(min.z, p.z);
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, p.y);
      max.z = Math.max(max.z, p.z);
    }
    const counts = new Map<string | null, number>();
    for (const o of owners) counts.set(o, (counts.get(o) ?? 0) + 1);
    let expectedOwner: string | null = null;
    let bc = -1;
    for (const [o, n] of counts) if (n > bc) {
      bc = n;
      expectedOwner = o;
    }
    regions.push({
      kind: b.kind,
      points: pts.length,
      centroid: { x: c.x / pts.length, y: c.y / pts.length, z: c.z / pts.length },
      min,
      max,
      expectedOwner,
      meanDeltaM: deltas.reduce((s, d) => s + d, 0) / deltas.length,
    });
  }
  regions.sort((a, b) => b.points - a.points);
  const owners: LidarComparison['owners'] = {};
  for (const [k, v] of Object.entries(ownerStats)) owners[k] = { rays: v.rays, consistent: v.consistent, rms: v.consistent ? Math.sqrt(v.sq / v.consistent) : 0 };
  return {
    rays: scan.ranges.length,
    returns,
    consistent,
    closer,
    farther,
    rmsResidualM: nsq ? Math.sqrt(sq / nsq) : 0,
    regions,
    owners,
  };
}

/**
 * 2.5D digital surface model from scan points within a footprint: max height per cell. Cells without
 * returns are left as NaN (UNKNOWN) — the renderer must not fill them in.
 */
export function buildDsm(scans: RangeScan[], bounds: { x0: number; y0: number; x1: number; y1: number }, cellM = 2): { cols: number; rows: number; cellM: number; x0: number; y0: number; heights: Float32Array; counts: Uint16Array } {
  const cols = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / cellM));
  const rows = Math.max(1, Math.ceil((bounds.y1 - bounds.y0) / cellM));
  const heights = new Float32Array(cols * rows).fill(Number.NaN);
  const counts = new Uint16Array(cols * rows);
  for (const s of scans)
    for (let ei = 0; ei < s.elevationSteps; ei++)
      for (let ai = 0; ai < s.azimuthSteps; ai++) {
        const r = s.ranges[ei * s.azimuthSteps + ai]!;
        if (!Number.isFinite(r)) continue;
        const p = scanPoint(s, ai, ei, r);
        if (p.x < bounds.x0 || p.x >= bounds.x1 || p.y < bounds.y0 || p.y >= bounds.y1) continue;
        const c = Math.floor((p.x - bounds.x0) / cellM);
        const rr = Math.floor((p.y - bounds.y0) / cellM);
        const k = rr * cols + c;
        const h = heights[k]!;
        if (!Number.isFinite(h) || p.z > h) heights[k] = p.z;
        counts[k] = Math.min(65535, counts[k]! + 1);
      }
  return { cols, rows, cellM, x0: bounds.x0, y0: bounds.y0, heights, counts };
}
