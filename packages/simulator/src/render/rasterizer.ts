import { cameraBasis, dot, sub, type CameraPose, type Vec3 } from '@strata/domain';

/**
 * Minimal software rasteriser (z-buffered, perspective-correct, deferred shading). It exists so that the
 * synthetic camera adapters can produce real pixels from simulator truth without a GPU — the platform
 * receives these exactly as it would receive frames from a video management system.
 */
export interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  /** Index into the material table supplied to shade(). */
  material: number;
  normal: Vec3;
}

export interface GBuffer {
  width: number;
  height: number;
  invDepth: Float32Array;
  wx: Float32Array;
  wy: Float32Array;
  wz: Float32Array;
  tri: Int32Array;
}

const NEAR = 0.4;

interface CamV {
  x: number;
  y: number;
  z: number;
  w: Vec3;
}

function clipNear(vs: CamV[]): CamV[] {
  const out: CamV[] = [];
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % vs.length]!;
    const ain = a.z >= NEAR;
    const bin = b.z >= NEAR;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (NEAR - a.z) / (b.z - a.z);
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: NEAR,
        w: { x: a.w.x + (b.w.x - a.w.x) * t, y: a.w.y + (b.w.y - a.w.y) * t, z: a.w.z + (b.w.z - a.w.z) * t },
      });
    }
  }
  return out;
}

export function rasterize(pose: CameraPose, tris: Triangle[]): GBuffer {
  const W = pose.widthPx;
  const H = pose.heightPx;
  const n = W * H;
  const gb: GBuffer = {
    width: W,
    height: H,
    invDepth: new Float32Array(n),
    wx: new Float32Array(n),
    wy: new Float32Array(n),
    wz: new Float32Array(n),
    tri: new Int32Array(n).fill(-1),
  };
  const B = cameraBasis(pose);
  const toCam = (p: Vec3): CamV => {
    const d = sub(p, pose.position);
    return { x: dot(d, B.right), y: dot(d, B.up), z: dot(d, B.forward), w: p };
  };
  for (let ti = 0; ti < tris.length; ti++) {
    const t = tris[ti]!;
    // Back-face cull in world space.
    const toTri = sub(t.a, pose.position);
    if (dot(toTri, t.normal) > 0.01) continue;
    let poly = [toCam(t.a), toCam(t.b), toCam(t.c)];
    if (poly[0]!.z < NEAR && poly[1]!.z < NEAR && poly[2]!.z < NEAR) continue;
    if (poly.some((v) => v.z < NEAR)) poly = clipNear(poly);
    if (poly.length < 3) continue;
    const sv = poly.map((v) => ({ sx: B.cx + (B.fx * v.x) / v.z, sy: B.cy - (B.fy * v.y) / v.z, iz: 1 / v.z, wx: v.w.x / v.z, wy: v.w.y / v.z, wz: v.w.z / v.z }));
    for (let k = 1; k + 1 < sv.length; k++) {
      const v0 = sv[0]!;
      const v1 = sv[k]!;
      const v2 = sv[k + 1]!;
      const area = (v1.sx - v0.sx) * (v2.sy - v0.sy) - (v1.sy - v0.sy) * (v2.sx - v0.sx);
      if (Math.abs(area) < 1e-9) continue;
      const minX = Math.max(0, Math.floor(Math.min(v0.sx, v1.sx, v2.sx)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(v0.sx, v1.sx, v2.sx)));
      const minY = Math.max(0, Math.floor(Math.min(v0.sy, v1.sy, v2.sy)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(v0.sy, v1.sy, v2.sy)));
      if (minX > maxX || minY > maxY) continue;
      const inv = 1 / area;
      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const w0 = ((v1.sx - px) * (v2.sy - py) - (v1.sy - py) * (v2.sx - px)) * inv;
          const w1 = ((v2.sx - px) * (v0.sy - py) - (v2.sy - py) * (v0.sx - px)) * inv;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const iz = w0 * v0.iz + w1 * v1.iz + w2 * v2.iz;
          const idx = y * W + x;
          if (iz <= gb.invDepth[idx]!) continue;
          gb.invDepth[idx] = iz;
          gb.wx[idx] = (w0 * v0.wx + w1 * v1.wx + w2 * v2.wx) / iz;
          gb.wy[idx] = (w0 * v0.wy + w1 * v1.wy + w2 * v2.wy) / iz;
          gb.wz[idx] = (w0 * v0.wz + w1 * v1.wz + w2 * v2.wz) / iz;
          gb.tri[idx] = ti;
        }
      }
    }
  }
  return gb;
}
