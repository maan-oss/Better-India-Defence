import type { Vec3 } from '../math/vec.ts';
import { add, cross, directionFromHeadingPitch, dot, normalize, scale, sub, DEG } from '../math/vec.ts';
import { terrainHeight } from '../facility/terrain.ts';

/** Pinhole camera with yaw/pitch pose (roll = 0). Shared by the simulator, ingestion geolocation and the renderer. */
export interface CameraPose {
  position: Vec3;
  headingDeg: number;
  pitchDeg: number;
  hfovDeg: number;
  widthPx: number;
  heightPx: number;
}

export interface CameraBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

const WORLD_UP: Vec3 = { x: 0, y: 0, z: 1 };

export function cameraBasis(c: CameraPose): CameraBasis {
  const forward = directionFromHeadingPitch(c.headingDeg, c.pitchDeg);
  const right = normalize(cross(forward, WORLD_UP));
  const up = cross(right, forward);
  const fx = c.widthPx / 2 / Math.tan((c.hfovDeg * DEG) / 2);
  return { forward, right, up, fx, fy: fx, cx: c.widthPx / 2, cy: c.heightPx / 2 };
}

export const verticalFov = (c: CameraPose): number => {
  const b = cameraBasis(c);
  return (2 * Math.atan(c.heightPx / 2 / b.fy)) / DEG;
};

/** Project a world point to pixel coordinates. Returns null if behind the camera. depth is along the optical axis. */
export function projectPoint(c: CameraPose, p: Vec3, basis: CameraBasis = cameraBasis(c)): { u: number; v: number; depth: number } | null {
  const d = sub(p, c.position);
  const zc = dot(d, basis.forward);
  if (zc <= 0.05) return null;
  return { u: basis.cx + (basis.fx * dot(d, basis.right)) / zc, v: basis.cy - (basis.fy * dot(d, basis.up)) / zc, depth: zc };
}

/** Unit ray through a pixel. */
export function pixelRay(c: CameraPose, u: number, v: number, basis: CameraBasis = cameraBasis(c)): Vec3 {
  return normalize(add(add(basis.forward, scale(basis.right, (u - basis.cx) / basis.fx)), scale(basis.up, (basis.cy - v) / basis.fy)));
}

/** March a ray against the terrain model; returns the first ground intersection or null within maxRange. */
export function rayTerrain(origin: Vec3, dir: Vec3, maxRange: number, step = 4): Vec3 | null {
  let prevT = 0;
  let prevAbove = origin.z - terrainHeight(origin.x, origin.y);
  if (prevAbove < 0) return null;
  for (let t = step; t <= maxRange; t += step) {
    const x = origin.x + dir.x * t;
    const y = origin.y + dir.y * t;
    const z = origin.z + dir.z * t;
    const above = z - terrainHeight(x, y);
    if (above <= 0) {
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        const mx = origin.x + dir.x * mid;
        const my = origin.y + dir.y * mid;
        if (origin.z + dir.z * mid - terrainHeight(mx, my) > 0) lo = mid;
        else hi = mid;
      }
      const tt = (lo + hi) / 2;
      return { x: origin.x + dir.x * tt, y: origin.y + dir.y * tt, z: origin.z + dir.z * tt };
    }
    prevT = t;
    prevAbove = above;
  }
  void prevAbove;
  return null;
}

/**
 * Ground footprint of the view frustum: corner rays (and points along the edges) intersected with terrain,
 * capped at the camera's range. Used for coverage polygons and frustum visualisation.
 */
export function frustumFootprint(c: CameraPose, rangeM: number, samplesPerEdge = 6): Vec3[] {
  const basis = cameraBasis(c);
  const pts: Vec3[] = [];
  const edge = (u0: number, v0: number, u1: number, v1: number) => {
    for (let i = 0; i < samplesPerEdge; i++) {
      const t = i / samplesPerEdge;
      const dir = pixelRay(c, u0 + (u1 - u0) * t, v0 + (v1 - v0) * t, basis);
      const hit = rayTerrain(c.position, dir, rangeM, 6);
      if (hit) pts.push(hit);
      else {
        const x = c.position.x + dir.x * rangeM;
        const y = c.position.y + dir.y * rangeM;
        pts.push({ x, y, z: terrainHeight(x, y) });
      }
    }
  };
  const w = c.widthPx;
  const h = c.heightPx;
  edge(0, h, w, h);
  edge(w, h, w, 0);
  edge(w, 0, 0, 0);
  edge(0, 0, 0, h);
  return pts;
}

/** True if a world point lies within the camera's field of view and range (ignores occlusion). */
export function inFieldOfView(c: CameraPose, p: Vec3, rangeM: number): boolean {
  const pr = projectPoint(c, p);
  if (!pr) return false;
  if (pr.depth > rangeM) return false;
  return pr.u >= 0 && pr.u <= c.widthPx && pr.v >= 0 && pr.v <= c.heightPx;
}
