import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import {
  BoxIndex,
  FACILITY,
  baselineBoxes,
  boxFootprint,
  buildDsm,
  buildPatches,
  cameraPatchQuality,
  castScan,
  compareScan,
  crop,
  decodeScan,
  detectChanges,
  getCameras,
  grayToRgba,
  makeGray,
  multiFrameReconstruct,
  originalUpscaled,
  pointInPolygon,
  psnr,
  renderMarking,
  rgbaToGray,
  scanPoint,
  singleFrameRestore,
  ssim,
  terrainHeight,
  type Gray,
  type SolidBox,
  type SurfacePatch,
  type Vec3,
} from '@strata/domain';

/**
 * Heavy analysis jobs. Pure functions over bytes/arrays so they run in a worker thread and in tests.
 */

let patchCache: { patches: SurfacePatch[]; byOwner: Map<string, SurfacePatch[]> } | null = null;
export function patches(): { patches: SurfacePatch[]; byOwner: Map<string, SurfacePatch[]> } {
  if (!patchCache) {
    const ps = buildPatches(FACILITY);
    const byOwner = new Map<string, SurfacePatch[]>();
    for (const p of ps) {
      const a = byOwner.get(p.ownerId) ?? [];
      a.push(p);
      byOwner.set(p.ownerId, a);
    }
    patchCache = { patches: ps, byOwner };
  }
  return patchCache;
}

/** Static camera → patch visibility/quality matrix against baseline geometry. */
export function computeVisibility(): Record<string, [string, number][]> {
  const index = new BoxIndex(baselineBoxes(FACILITY));
  const out: Record<string, [string, number][]> = {};
  for (const cam of getCameras()) {
    const rows: [string, number][] = [];
    for (const p of patches().patches) {
      const q = cameraPatchQuality(cam, p, index);
      if (q > 0) rows.push([p.id, q]);
    }
    out[cam.id] = rows;
  }
  return out;
}

function nearestPatch(owner: string, p: Vec3): SurfacePatch | null {
  if (owner === 'terrain' || !owner) {
    const id = `ground:${Math.floor(p.x / 80)}:${Math.floor(p.y / 80)}`;
    return patches().patches.find((x) => x.id === id) ?? null;
  }
  const cands = patches().byOwner.get(owner);
  if (!cands) return null;
  let best: SurfacePatch | null = null;
  let bd = Infinity;
  for (const c of cands) {
    if (c.kind === 'interior') continue;
    const d = Math.hypot(c.center.x - p.x, c.center.y - p.y, c.center.z - p.z);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

export interface LidarCompareInput {
  scan: Uint8Array;
  expected: SolidBox[];
  transient: Vec3[];
}

export interface LidarCompareOutput {
  stats: { rays: number; returns: number; consistent: number; closer: number; farther: number; rmsResidualM: number };
  regions: { kind: 'closer' | 'farther'; points: number; centroid: Vec3; min: Vec3; max: Vec3; expectedOwner: string | null; meanDeltaM: number; transient: boolean }[];
  patchSupport: Record<string, { points: number; rms: number }>;
  sensorId: string;
  t: number;
}

export function lidarCompare(input: LidarCompareInput): LidarCompareOutput {
  const scan = decodeScan(input.scan);
  const index = new BoxIndex(input.expected);
  const expected = castScan(scan, index);
  const cmp = compareScan(scan, expected.ranges, expected.owners);
  const regions = cmp.regions.map((r) => {
    const transient = r.kind === 'closer' && input.transient.some((p) => Math.hypot(p.x - r.centroid.x, p.y - r.centroid.y) < 10);
    return { ...r, transient };
  });
  // Per-patch support from rays whose measured return agrees with the expected surface.
  const support: Record<string, { points: number; sq: number }> = {};
  for (let ei = 0; ei < scan.elevationSteps; ei++)
    for (let ai = 0; ai < scan.azimuthSteps; ai++) {
      const i = ei * scan.azimuthSteps + ai;
      const rm = scan.ranges[i]!;
      const re = expected.ranges[i]!;
      if (!Number.isFinite(rm) || !Number.isFinite(re) || Math.abs(rm - re) > 0.6) continue;
      const owner = expected.owners[i] ?? 'terrain';
      const p = scanPoint(scan, ai, ei, rm);
      const patch = nearestPatch(owner, p);
      if (!patch) continue;
      const s = (support[patch.id] ??= { points: 0, sq: 0 });
      s.points++;
      s.sq += (rm - re) ** 2;
    }
  const patchSupport: LidarCompareOutput['patchSupport'] = {};
  for (const [k, v] of Object.entries(support)) if (v.points >= 3) patchSupport[k] = { points: v.points, rms: Math.round(Math.sqrt(v.sq / v.points) * 1000) / 1000 };
  return {
    stats: { rays: cmp.rays, returns: cmp.returns, consistent: cmp.consistent, closer: cmp.closer, farther: cmp.farther, rmsResidualM: Math.round(cmp.rmsResidualM * 1000) / 1000 },
    regions,
    patchSupport,
    sensorId: scan.sensorId,
    t: scan.t,
  };
}

export interface DsmInput {
  scans: Uint8Array[];
  buildingId: string;
  cellM: number;
}

export function dsmReconstruct(input: DsmInput) {
  const b = FACILITY.buildings.find((x) => x.id === input.buildingId);
  if (!b) throw new Error('unknown building');
  const fp = boxFootprint(b);
  const bounds = { x0: Math.min(...fp.map((p) => p.x)) - 2, y0: Math.min(...fp.map((p) => p.y)) - 2, x1: Math.max(...fp.map((p) => p.x)) + 2, y1: Math.max(...fp.map((p) => p.y)) + 2 };
  const scans = input.scans.map(decodeScan);
  const dsm = buildDsm(scans, bounds, input.cellM);
  const baseZ = terrainHeight(b.center.x, b.center.y);
  // Keep only cells inside the footprint; outside cells are ground and not part of the structure.
  let known = 0;
  let inside = 0;
  let maxH = 0;
  for (let r = 0; r < dsm.rows; r++)
    for (let c = 0; c < dsm.cols; c++) {
      const k = r * dsm.cols + c;
      const p = { x: dsm.x0 + (c + 0.5) * dsm.cellM, y: dsm.y0 + (r + 0.5) * dsm.cellM };
      if (!pointInPolygon(p, fp)) {
        dsm.heights[k] = Number.NaN;
        continue;
      }
      inside++;
      if (Number.isFinite(dsm.heights[k]!)) {
        known++;
        maxH = Math.max(maxH, dsm.heights[k]! - baseZ);
      }
    }
  const heights = Buffer.from(dsm.heights.buffer, dsm.heights.byteOffset, dsm.heights.byteLength).toString('base64');
  return {
    geometry: { type: 'dsm' as const, x0: dsm.x0, y0: dsm.y0, cellM: dsm.cellM, cols: dsm.cols, rows: dsm.rows, heights, baseZ },
    coverage: inside ? known / inside : 0,
    knownCells: known,
    footprintCells: inside,
    maxHeightM: Math.round(maxH * 10) / 10,
    scansUsed: scans.map((s) => ({ sensorId: s.sensorId, scanId: s.scanId, t: s.t })),
  };
}

function decodePngGray(bytes: Uint8Array): Gray {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return rgbaToGray(png.data, png.width, png.height);
}

export interface ImageryDiffInput {
  a: Uint8Array;
  b: Uint8Array;
  gsdM: number;
  halfExtentM: number;
  transient: Vec3[];
}

export function imageryDiff(input: ImageryDiffInput) {
  const A = decodePngGray(input.a);
  const B = decodePngGray(input.b);
  const r = detectChanges(A, B, { k: 7, minPixels: 6, minAbs: 0.07 });
  const toWorld = (px: number, py: number) => ({ x: -input.halfExtentM + (px + 0.5) * input.gsdM, y: input.halfExtentM - (py + 0.5) * input.gsdM });
  return {
    threshold: r.threshold,
    regions: r.regions.slice(0, 40).map((reg) => {
      const c = toWorld(reg.centroid.x, reg.centroid.y);
      const p0 = toWorld(reg.bbox[0], reg.bbox[3]);
      const p1 = toWorld(reg.bbox[2], reg.bbox[1]);
      const transient = input.transient.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < 15);
      return { centroid: c, min: p0, max: p1, areaM2: reg.pixels * input.gsdM * input.gsdM, meanDiff: Math.round(reg.meanDiff * 1000) / 1000, transient };
    }),
  };
}

export interface MultiFrameInput {
  frames: { t: number; jpeg: Uint8Array }[];
  roi: { x: number; y: number; w: number; h: number };
  scale: number;
  reference?: { text: string };
}

function encodePng(g: Gray): Uint8Array {
  const png = new PNG({ width: g.width, height: g.height });
  png.data.set(grayToRgba(g));
  const b = PNG.sync.write(png);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

export function multiFrame(input: MultiFrameInput) {
  const crops: Gray[] = input.frames.map((f) => {
    const img = jpeg.decode(Buffer.from(f.jpeg.buffer, f.jpeg.byteOffset, f.jpeg.byteLength), { useTArray: true });
    return crop(rgbaToGray(img.data, img.width, img.height), input.roi.x, input.roi.y, input.roi.w, input.roi.h);
  });
  const s = input.scale;
  const mf = multiFrameReconstruct(crops, s, 20);
  const original = originalUpscaled(crops[0]!, s);
  const restored = singleFrameRestore(crops[0]!, s);
  let metrics: Record<string, { psnr: number; ssim: number }> | null = null;
  if (input.reference) {
    // Reference marking from the site register — used ONLY to score outputs, never as an input.
    const ref = renderMarking(input.reference.text, mf.hr.width, mf.hr.height);
    const refG = makeGray(ref.width, ref.height);
    refG.data.set(ref.data);
    const score = (g: Gray) => ({ psnr: Math.round(psnr(normalizeRange(g), refG) * 100) / 100, ssim: Math.round(ssim(normalizeRange(g), refG) * 1000) / 1000 });
    metrics = { original: score(original), restored: score(restored), multiFrame: score(mf.hr) };
  }
  return {
    images: { original: encodePng(original), restored: encodePng(restored), multiFrame: encodePng(mf.hr) },
    registrations: mf.registrations.map((r, i) => ({ t: input.frames[i]!.t, dx: Math.round(r.dx * 1000) / 1000, dy: Math.round(r.dy * 1000) / 1000, residual: Math.round(r.residual * 10000) / 10000 })),
    usedFrames: mf.usedFrames.length,
    rejectedFrames: mf.rejectedFrames.length,
    metrics,
    size: { w: mf.hr.width, h: mf.hr.height },
  };
}

/** Stretch to the reference's dynamic range (0.12–0.90) before scoring so exposure differences don't dominate. */
function normalizeRange(g: Gray): Gray {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of g.data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const out = makeGray(g.width, g.height);
  const k = hi - lo > 1e-6 ? 0.78 / (hi - lo) : 1;
  for (let i = 0; i < g.data.length; i++) out.data[i] = 0.12 + (g.data[i]! - lo) * k;
  return out;
}
