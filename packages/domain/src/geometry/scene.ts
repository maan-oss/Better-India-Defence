import type { Vec3 } from '../math/vec.ts';
import { sub, length, scale } from '../math/vec.ts';
import type { BuildingDef, FacilityDef, StaticObjectDef } from '../facility/types.ts';
import { terrainHeight } from '../facility/terrain.ts';
import { rayBox, type RayHit, type SolidBox } from './box.ts';
import { rayTerrain } from './camera.ts';

/**
 * Physical state of a building part. A building normally has one part; structural damage is modelled by
 * splitting it into parts with reduced heights (e.g. a partial roof collapse).
 */
export interface BuildingPartState {
  id: string;
  /** Fractional extent along the building's local x axis, [0,1]. */
  fx0: number;
  fx1: number;
  height: number;
  /** Collapsed / damaged part: rendered as rubble by imaging sensor models. */
  damaged?: boolean;
}

export function buildingBoxes(def: BuildingDef, parts?: BuildingPartState[]): SolidBox[] {
  const material: SolidBox['material'] =
    def.kind === 'hangar' || def.kind === 'warehouse' || def.kind === 'mast' ? 'metal' : def.kind === 'tank' ? 'tank' : 'concrete';
  const z0 = terrainHeight(def.center.x, def.center.y);
  const ps = parts ?? [{ id: `${def.id}#0`, fx0: 0, fx1: 1, height: def.height }];
  const yaw = (def.yawDeg * Math.PI) / 180;
  return ps.map((p) => {
    const mid = (p.fx0 + p.fx1) / 2 - 0.5;
    const off = mid * def.width;
    return {
      id: p.id,
      ownerId: def.id,
      center: { x: def.center.x + off * Math.cos(yaw), y: def.center.y + off * Math.sin(yaw) },
      z0,
      width: (p.fx1 - p.fx0) * def.width,
      depth: def.depth,
      height: p.height,
      yawDeg: def.yawDeg,
      material: p.damaged ? 'debris' : material,
    };
  });
}

export function staticObjectBox(o: StaticObjectDef): SolidBox {
  return {
    id: o.id,
    ownerId: o.id,
    center: o.center,
    z0: terrainHeight(o.center.x, o.center.y),
    width: o.width,
    depth: o.depth,
    height: o.height,
    yawDeg: o.yawDeg,
    material: o.kind === 'container' ? 'container' : o.kind === 'parked_vehicle' ? 'vehicle' : o.kind === 'debris' ? 'debris' : 'metal',
  };
}

export function baselineBoxes(f: FacilityDef): SolidBox[] {
  return [...f.buildings.flatMap((b) => buildingBoxes(b)), ...f.staticObjects.map(staticObjectBox)];
}

/**
 * Uniform-grid spatial index over boxes for fast ray queries (spatial culling). Cell size ~100 m keeps
 * bucket sizes small for a 5 km site.
 */
export class BoxIndex {
  private readonly cells = new Map<number, SolidBox[]>();
  readonly boxes: SolidBox[];

  constructor(boxes: SolidBox[], private readonly cell = 100) {
    this.boxes = boxes;
    for (const b of boxes) {
      const r = Math.hypot(b.width, b.depth) / 2;
      const x0 = Math.floor((b.center.x - r) / cell);
      const x1 = Math.floor((b.center.x + r) / cell);
      const y0 = Math.floor((b.center.y - r) / cell);
      const y1 = Math.floor((b.center.y + r) / cell);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const k = this.key(x, y);
          const arr = this.cells.get(k);
          if (arr) arr.push(b);
          else this.cells.set(k, [b]);
        }
    }
  }

  private key(x: number, y: number): number {
    return (x + 1000) * 4096 + (y + 1000);
  }

  /** Candidate boxes along a 2D ray segment using a DDA traversal of the grid. */
  candidates(origin: Vec3, dir: Vec3, maxT: number): SolidBox[] {
    const out = new Set<SolidBox>();
    const c = this.cell;
    let cx = Math.floor(origin.x / c);
    let cy = Math.floor(origin.y / c);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepY = dir.y > 0 ? 1 : -1;
    const tDeltaX = Math.abs(dir.x) > 1e-9 ? Math.abs(c / dir.x) : Infinity;
    const tDeltaY = Math.abs(dir.y) > 1e-9 ? Math.abs(c / dir.y) : Infinity;
    const nextX = (cx + (stepX > 0 ? 1 : 0)) * c;
    const nextY = (cy + (stepY > 0 ? 1 : 0)) * c;
    let tMaxX = Math.abs(dir.x) > 1e-9 ? (nextX - origin.x) / dir.x : Infinity;
    let tMaxY = Math.abs(dir.y) > 1e-9 ? (nextY - origin.y) / dir.y : Infinity;
    let t = 0;
    for (let guard = 0; guard < 10000 && t <= maxT; guard++) {
      const arr = this.cells.get(this.key(cx, cy));
      if (arr) for (const b of arr) out.add(b);
      if (tMaxX < tMaxY) {
        t = tMaxX;
        tMaxX += tDeltaX;
        cx += stepX;
      } else {
        t = tMaxY;
        tMaxY += tDeltaY;
        cy += stepY;
      }
    }
    return [...out];
  }
}

/** Ray against boxes + terrain. */
export function raycastScene(index: BoxIndex, origin: Vec3, dir: Vec3, maxT: number, extra: SolidBox[] = []): RayHit | null {
  let best: RayHit | null = null;
  const consider = (b: SolidBox) => {
    const h = rayBox(origin, dir, b, best ? best.t : maxT);
    if (h && (!best || h.t < best.t)) {
      best = {
        t: h.t,
        point: { x: origin.x + dir.x * h.t, y: origin.y + dir.y * h.t, z: origin.z + dir.z * h.t },
        normal: h.normal,
        boxId: b.id,
        ownerId: b.ownerId,
      };
    }
  };
  for (const b of index.candidates(origin, dir, maxT)) consider(b);
  for (const b of extra) consider(b);
  const found = best as RayHit | null;
  const ground = rayTerrain(origin, dir, found ? found.t : maxT, 3);
  if (ground) {
    const t = length(sub(ground, origin));
    if (!found || t < found.t) return { t, point: ground, normal: { x: 0, y: 0, z: 1 }, boxId: null, ownerId: null };
  }
  return found;
}

/** Line-of-sight check between two points (true = unobstructed). `ignoreOwner` excludes the target's own volume. */
export function lineOfSight(index: BoxIndex, from: Vec3, to: Vec3, ignoreOwner?: string): boolean {
  const d = sub(to, from);
  const l = length(d);
  if (l < 1e-6) return true;
  const dir = scale(d, 1 / l);
  for (const b of index.candidates(from, dir, l)) {
    if (ignoreOwner && b.ownerId === ignoreOwner) continue;
    const h = rayBox(from, dir, b, l - 0.5);
    if (h) return false;
  }
  // Terrain occlusion: sample along the segment.
  const n = Math.min(200, Math.ceil(l / 10));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = from.x + d.x * t;
    const y = from.y + d.y * t;
    if (from.z + d.z * t < terrainHeight(x, y) - 0.2) return false;
  }
  return true;
}
