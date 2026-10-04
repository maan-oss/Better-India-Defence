import type { Vec2, Vec3 } from '../math/vec.ts';
import { DEG } from '../math/vec.ts';

/** An oriented (yaw-only) solid box. All buildings, objects and entity volumes are modelled with these. */
export interface SolidBox {
  id: string;
  /** Asset that owns the box (building id, object id, entity id). */
  ownerId: string;
  center: Vec2;
  /** Base elevation, metres. */
  z0: number;
  width: number;
  depth: number;
  height: number;
  yawDeg: number;
  material: 'concrete' | 'metal' | 'glass' | 'vehicle' | 'person' | 'drone' | 'debris' | 'container' | 'tank';
}

export interface RayHit {
  t: number;
  point: Vec3;
  normal: Vec3;
  boxId: string | null;
  ownerId: string | null;
}

/** Slab-test intersection of a ray with an oriented box. Returns distance along the (unit) direction, or null. */
export function rayBox(origin: Vec3, dir: Vec3, box: SolidBox, maxT = Infinity): { t: number; normal: Vec3 } | null {
  const yaw = box.yawDeg * DEG;
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const ox = origin.x - box.center.x;
  const oy = origin.y - box.center.y;
  const lo = { x: ox * c - oy * s, y: ox * s + oy * c, z: origin.z };
  const ld = { x: dir.x * c - dir.y * s, y: dir.x * s + dir.y * c, z: dir.z };
  const hx = box.width / 2;
  const hy = box.depth / 2;
  let tMin = 0;
  let tMax = maxT;
  let axis = -1;
  let sign = 1;
  const bounds: [number, number, number, number][] = [
    [lo.x, ld.x, -hx, hx],
    [lo.y, ld.y, -hy, hy],
    [lo.z, ld.z, box.z0, box.z0 + box.height],
  ];
  for (let i = 0; i < 3; i++) {
    const b = bounds[i]!;
    const [o, d, mn, mx] = b;
    if (Math.abs(d) < 1e-12) {
      if (o < mn || o > mx) return null;
      continue;
    }
    let t1 = (mn - o) / d;
    let t2 = (mx - o) / d;
    let s1 = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s1 = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = i;
      sign = s1;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  if (axis === -1) return null; // origin inside the box
  const ln = { x: 0, y: 0, z: 0 };
  if (axis === 0) ln.x = sign;
  else if (axis === 1) ln.y = sign;
  else ln.z = sign;
  const cw = Math.cos(yaw);
  const sw = Math.sin(yaw);
  return { t: tMin, normal: { x: ln.x * cw - ln.y * sw, y: ln.x * sw + ln.y * cw, z: ln.z } };
}

/** Corners of the footprint polygon (counter-clockwise). */
export function boxFootprint(box: Pick<SolidBox, 'center' | 'width' | 'depth' | 'yawDeg'>): Vec2[] {
  const yaw = box.yawDeg * DEG;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hx = box.width / 2;
  const hy = box.depth / 2;
  return [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ].map(([lx, ly]) => ({ x: box.center.x + lx! * c - ly! * s, y: box.center.y + lx! * s + ly! * c }));
}

/** True if the point lies inside the box volume. */
export function pointInBox(p: Vec3, box: SolidBox, margin = 0): boolean {
  const yaw = box.yawDeg * DEG;
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const dx = p.x - box.center.x;
  const dy = p.y - box.center.y;
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return (
    Math.abs(lx) <= box.width / 2 + margin &&
    Math.abs(ly) <= box.depth / 2 + margin &&
    p.z >= box.z0 - margin &&
    p.z <= box.z0 + box.height + margin
  );
}

/** Signed distance from a point to the box surface (negative inside). Used for LiDAR residuals. */
export function distanceToBox(p: Vec3, box: SolidBox): number {
  const yaw = box.yawDeg * DEG;
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const dx = p.x - box.center.x;
  const dy = p.y - box.center.y;
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  const lz = p.z - (box.z0 + box.height / 2);
  const qx = Math.abs(lx) - box.width / 2;
  const qy = Math.abs(ly) - box.depth / 2;
  const qz = Math.abs(lz) - box.height / 2;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  const inside = Math.min(Math.max(qx, qy, qz), 0);
  return outside + inside;
}
