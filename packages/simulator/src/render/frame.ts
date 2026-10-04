import {
  FACILITY,
  cameraBasis,
  drawText,
  gaussianAt,
  hashString,
  terrainHeight,
  textCoverage,
  type CameraPose,
  type MarkingDef,
  type SolidBox,
  type Vec3,
} from '@strata/domain';
import { rasterize, type Triangle } from './rasterizer.ts';
import { cachedHeight, groundColor, groundShade, sunDirection, type RGB } from './ground.ts';
import type { TruthWorld } from '../truth/world.ts';

interface Material {
  kind: 'ground' | 'solid' | 'facade' | 'marking';
  color: RGB;
  normal: Vec3;
  /** For marking faces: wall-local frame. */
  marking?: { def: MarkingDef; origin: Vec3; u: Vec3; v: Vec3; w: number; h: number };
}

const MATERIAL_COLORS: Record<SolidBox['material'], RGB> = {
  concrete: [168, 164, 156],
  metal: [140, 146, 150],
  glass: [90, 100, 110],
  vehicle: [80, 84, 90],
  person: [80, 70, 60],
  drone: [34, 34, 36],
  debris: [120, 112, 100],
  container: [150, 92, 60],
  tank: [190, 190, 184],
};

function pushBox(tris: Triangle[], mats: Material[], box: SolidBox, color: RGB, facade: boolean, markings: MarkingDef[] = []): void {
  const yaw = (box.yawDeg * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hw = box.width / 2;
  const hd = box.depth / 2;
  const P = (lx: number, ly: number, z: number): Vec3 => ({ x: box.center.x + lx * c - ly * s, y: box.center.y + lx * s + ly * c, z });
  const z0 = box.z0;
  const z1 = box.z0 + box.height;
  const N = (nx: number, ny: number, nz: number): Vec3 => ({ x: nx * c - ny * s, y: nx * s + ny * c, z: nz });
  const faces: { q: [Vec3, Vec3, Vec3, Vec3]; n: Vec3; side?: MarkingDef['face'] }[] = [
    { q: [P(-hw, hd, z0), P(hw, hd, z0), P(hw, hd, z1), P(-hw, hd, z1)], n: N(0, 1, 0), side: 'north' },
    { q: [P(hw, -hd, z0), P(-hw, -hd, z0), P(-hw, -hd, z1), P(hw, -hd, z1)], n: N(0, -1, 0), side: 'south' },
    { q: [P(hw, hd, z0), P(hw, -hd, z0), P(hw, -hd, z1), P(hw, hd, z1)], n: N(1, 0, 0), side: 'east' },
    { q: [P(-hw, -hd, z0), P(-hw, hd, z0), P(-hw, hd, z1), P(-hw, -hd, z1)], n: N(-1, 0, 0), side: 'west' },
    { q: [P(-hw, -hd, z1), P(hw, -hd, z1), P(hw, hd, z1), P(-hw, hd, z1)], n: { x: 0, y: 0, z: 1 } },
  ];
  for (const f of faces) {
    const mk = markings.find((m) => m.face === f.side);
    const mat: Material = { kind: facade && f.side ? 'facade' : 'solid', color, normal: f.n };
    if (mk && f.side) {
      // Face-local frame: u along the wall (left→right seen from outside), v up.
      // u runs left→right as seen by a viewer facing the wall from outside.
      const a = f.q[0]!;
      const b = f.q[1]!;
      const len = Math.hypot(a.x - b.x, a.y - b.y);
      const u = { x: (a.x - b.x) / len, y: (a.y - b.y) / len, z: 0 };
      const centre = { x: (a.x + b.x) / 2 + u.x * mk.offsetM, y: (a.y + b.y) / 2 + u.y * mk.offsetM, z: z0 + mk.elevationM };
      mat.kind = 'marking';
      mat.marking = {
        def: mk,
        origin: { x: centre.x - (u.x * mk.widthM) / 2, y: centre.y - (u.y * mk.widthM) / 2, z: centre.z + mk.heightM / 2 },
        u,
        v: { x: 0, y: 0, z: -1 },
        w: mk.widthM,
        h: mk.heightM,
      };
    }
    const mi = mats.length;
    mats.push(mat);
    tris.push({ a: f.q[0], b: f.q[2], c: f.q[1], material: mi, normal: f.n });
    tris.push({ a: f.q[0], b: f.q[3], c: f.q[2], material: mi, normal: f.n });
  }
}

/** Terrain tiles around the camera at three levels of detail, culled to the forward half-space. */
function pushTerrain(tris: Triangle[], mats: Material[], pose: CameraPose, rangeM: number): void {
  const B = cameraBasis(pose);
  const groundMat = mats.length;
  mats.push({ kind: 'ground', color: [0, 0, 0], normal: { x: 0, y: 0, z: 1 } });
  const levels = [
    { cell: 3, half: 60 },
    { cell: 10, half: 260 },
    { cell: 30, half: 900 },
    { cell: 80, half: Math.max(900, Math.min(2600, rangeM * 1.3)) },
  ];
  const cx = pose.position.x;
  const cy = pose.position.y;
  let inner = 0;
  for (const L of levels) {
    const x0 = Math.floor((cx - L.half) / L.cell) * L.cell;
    const y0 = Math.floor((cy - L.half) / L.cell) * L.cell;
    const n = Math.ceil((2 * L.half) / L.cell) + 1;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const ax = x0 + i * L.cell;
        const ay = y0 + j * L.cell;
        const mx = ax + L.cell / 2;
        const my = ay + L.cell / 2;
        if (inner > 0 && Math.abs(mx - cx) < inner - L.cell / 2 && Math.abs(my - cy) < inner - L.cell / 2) continue;
        const dx = mx - cx;
        const dy = my - cy;
        const along = dx * B.forward.x + dy * B.forward.y;
        if (along < -L.cell * 1.5) continue;
        if (Math.hypot(dx, dy) > rangeM * 1.4 + L.cell) continue;
        const p00 = { x: ax, y: ay, z: cachedHeight(ax, ay) };
        const p10 = { x: ax + L.cell, y: ay, z: cachedHeight(ax + L.cell, ay) };
        const p01 = { x: ax, y: ay + L.cell, z: cachedHeight(ax, ay + L.cell) };
        const p11 = { x: ax + L.cell, y: ay + L.cell, z: cachedHeight(ax + L.cell, ay + L.cell) };
        const up = { x: 0, y: 0, z: 1 };
        tris.push({ a: p00, b: p11, c: p10, material: groundMat, normal: up });
        tris.push({ a: p00, b: p01, c: p11, material: groundMat, normal: up });
      }
    inner = L.half;
  }
}

export interface RenderOptions {
  label: string;
  rangeM: number;
  /** Excludes the carrying platform's own entity (drone cameras). */
  excludeEntityId?: string;
}

/** Render a camera frame from simulator truth at time t. Returns RGBA pixels. */
export function renderFrame(world: TruthWorld, pose: CameraPose, t: number, opts: RenderOptions): Uint8ClampedArray {
  const tris: Triangle[] = [];
  const mats: Material[] = [];
  pushTerrain(tris, mats, pose, opts.rangeM);
  const near = (b: { center: { x: number; y: number } }, r: number) => Math.hypot(b.center.x - pose.position.x, b.center.y - pose.position.y) < opts.rangeM * 1.3 + r;
  for (const box of world.staticBoxes(t)) {
    if (!near(box, Math.hypot(box.width, box.depth))) continue;
    const bld = FACILITY.buildings.find((b) => b.id === box.ownerId);
    const isFirstPart = !box.id.includes('#') || box.id.endsWith('#0') || box.id.endsWith('#w');
    pushBox(tris, mats, box, MATERIAL_COLORS[box.material], Boolean(bld), bld && isFirstPart ? (bld.markings ?? []) : []);
  }
  for (const e of world.entitiesAt(t)) {
    if (!e.state.visible || e.entity.id === opts.excludeEntityId) continue;
    const box = world.entityBox(e);
    if (!near(box, 5)) continue;
    if (e.entity.kind === 'person') {
      const legs = { ...box, height: box.height * 0.48 };
      const torso = { ...box, z0: box.z0 + box.height * 0.48, height: box.height * 0.52, id: `${box.id}:t` };
      pushBox(tris, mats, legs, e.entity.color.bottom, false);
      pushBox(tris, mats, torso, e.entity.color.top, false);
    } else if (e.entity.kind === 'bird') {
      for (let k = 0; k < 9; k++) {
        const ox = gaussianAt(hashString(e.entity.id), k, 1) * 2.5;
        const oy = gaussianAt(hashString(e.entity.id), k, 2) * 2.5;
        pushBox(tris, mats, { ...box, center: { x: box.center.x + ox, y: box.center.y + oy }, width: 0.5, depth: 0.25, height: 0.15, z0: box.z0 + k * 0.1 }, [60, 60, 60], false);
      }
    } else if (e.entity.kind === 'drone') {
      pushBox(tris, mats, box, e.entity.color.top, false);
      pushBox(tris, mats, { ...box, width: box.width * 2.2, depth: 0.08, height: 0.05, z0: box.z0 + box.height * 0.6 }, [20, 20, 22], false);
      pushBox(tris, mats, { ...box, width: 0.08, depth: box.depth * 2.2, height: 0.05, z0: box.z0 + box.height * 0.6 }, [20, 20, 22], false);
    } else pushBox(tris, mats, box, e.entity.color.top, false);
  }
  // Fence posts near the camera.
  const P = FACILITY.perimeterHalfM;
  for (const side of [0, 1, 2, 3]) {
    for (let s = -P; s <= P; s += 3) {
      const x = side === 0 ? s : side === 1 ? P : side === 2 ? s : -P;
      const y = side === 0 ? P : side === 1 ? s : side === 2 ? -P : s;
      if (Math.hypot(x - pose.position.x, y - pose.position.y) > 260) continue;
      pushBox(tris, mats, { id: 'fp', ownerId: 'fence', center: { x, y }, z0: terrainHeight(x, y), width: 0.08, depth: 0.08, height: 2.4, yawDeg: 0, material: 'metal' }, [70, 72, 74], false);
    }
  }
  const gb = rasterize(pose, tris);
  const sun = sunDirection(t);
  const W = gb.width;
  const H = gb.height;
  const out = new Uint8ClampedArray(W * H * 4);
  const B = cameraBasis(pose);
  const frameSeed = (hashString(opts.label) ^ Math.floor(t / 100)) >>> 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const ti = gb.tri[idx]!;
      let col: RGB;
      let dist: number;
      if (ti < 0) {
        // Sky gradient by ray elevation.
        const vy = (B.cy - (y + 0.5)) / B.fy;
        const el = B.forward.z + vy * B.up.z;
        const k = Math.max(0, Math.min(1, el * 3 + 0.2));
        col = [182 - 60 * k, 190 - 50 * k, 198 - 30 * k];
        dist = 0;
      } else {
        const m = mats[tris[ti]!.material]!;
        const wx = gb.wx[idx]!;
        const wy = gb.wy[idx]!;
        const wz = gb.wz[idx]!;
        dist = Math.hypot(wx - pose.position.x, wy - pose.position.y, wz - pose.position.z);
        if (m.kind === 'ground') {
          const gc = groundColor(wx, wy);
          const sh = groundShade(wx, wy, sun);
          col = [gc[0] * sh, gc[1] * sh, gc[2] * sh];
        } else {
          const lam = 0.5 + 0.5 * Math.max(0, m.normal.x * sun.x + m.normal.y * sun.y + m.normal.z * sun.z);
          col = [m.color[0] * lam, m.color[1] * lam, m.color[2] * lam];
          if (m.kind === 'facade' || m.kind === 'marking') {
            const band = (wz - cachedHeight(wx, wy)) % 4;
            if (m.normal.z < 0.5 && band > 2.2 && band < 3.1) col = [col[0] * 0.72, col[1] * 0.74, col[2] * 0.78];
          }
          if (m.kind === 'marking' && m.marking) {
            const mk = m.marking;
            const d = { x: wx - mk.origin.x, y: wy - mk.origin.y, z: wz - mk.origin.z };
            const u = (d.x * mk.u.x + d.y * mk.u.y) / mk.w;
            const v = (d.z * mk.v.z) / mk.h;
            if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
              // Box-filter the marking over the pixel footprint (sensor integration), 4×4 sub-samples.
              const foot = dist / B.fx;
              const du = foot / mk.w;
              const dv = foot / mk.h;
              let ink = 0;
              for (let sy = 0; sy < 4; sy++)
                for (let sx = 0; sx < 4; sx++) ink += textCoverage(mk.def.text, u + ((sx + 0.5) / 4 - 0.5) * du, v + ((sy + 0.5) / 4 - 0.5) * dv);
              ink /= 16;
              const plate = 0.12 + 0.78 * ink;
              col = [255 * plate * lam * 1.1, 255 * plate * lam * 1.1, 255 * plate * lam * 1.05];
            }
          }
        }
      }
      const fog = dist > 0 ? 1 - Math.exp(-dist / 3500) : 0;
      const haze: RGB = [178, 184, 190];
      const n = gaussianAt(frameSeed, idx, 1) * 3;
      out[idx * 4] = col[0] * (1 - fog) + haze[0] * fog + n;
      out[idx * 4 + 1] = col[1] * (1 - fog) + haze[1] * fog + n;
      out[idx * 4 + 2] = col[2] * (1 - fog) + haze[2] * fog + n;
      out[idx * 4 + 3] = 255;
    }
  applyPsf(out, W, H);
  const stamp = new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  drawText(out, W, H, `${opts.label}  ${stamp}Z`, 6, 6, 1, [236, 232, 220]);
  return out;
}

/** Optical point-spread function: 3×3 binomial blur (σ ≈ 0.7 px), applied before the burned-in overlay. */
function applyPsf(rgba: Uint8ClampedArray, W: number, H: number): void {
  const src = rgba.slice();
  const k = [1, 2, 1];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        let ws = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(W - 1, Math.max(0, x + dx));
            const yy = Math.min(H - 1, Math.max(0, y + dy));
            const w = k[dx + 1]! * k[dy + 1]!;
            s += w * src[(yy * W + xx) * 4 + c]!;
            ws += w;
          }
        rgba[(y * W + x) * 4 + c] = s / ws;
      }
}
