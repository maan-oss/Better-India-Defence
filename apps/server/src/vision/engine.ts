import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import {
  type Detection,
  type FaceDetection,
  type FaceQuality,
  type RgbImage,
  SECURITY_CLASSES,
  alignFace,
  cropRgb,
  decodeYolox,
  decodeYunet,
  faceQuality,
  l2normalize,
  letterboxBgr,
  makeRgb,
  nms,
  toChwRgb255,
} from '@strata/domain/vision';

/**
 * Local CPU inference for the vision models listed in models/manifest.json. Every model file is
 * SHA-256-verified before it is loaded; a missing or altered model disables only the features that need it.
 */
export type ModelKey = 'detector' | 'face_detector' | 'face_embedder' | 'super_resolution';

export interface ModelEntry {
  key: ModelKey;
  file: string;
  sha256: string;
  url: string;
  name: string;
  licence: string;
  purpose: string;
}

export interface ModelStatus extends Omit<ModelEntry, 'url'> {
  installed: boolean;
  verified: boolean;
  loaded: boolean;
  error: string | null;
}

export class ModelUnavailable extends Error {}

export function findModelsDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const cands = [resolve('models'), resolve(import.meta.dirname, '../../../../models'), resolve(import.meta.dirname, '../../../models')];
  return cands.find((c) => existsSync(join(c, 'manifest.json'))) ?? cands[0]!;
}

export interface FaceResult {
  face: FaceDetection;
  quality: FaceQuality;
  /** L2-normalised 128-d embedding; absent when the face is UNUSABLE. */
  embedding: number[] | null;
  /** Aligned 112×112 crop (for display / audit). */
  aligned: RgbImage;
}

export class VisionEngine {
  private readonly manifest: ModelEntry[];
  private readonly sessions = new Map<ModelKey, Promise<ort.InferenceSession>>();
  private readonly errors = new Map<ModelKey, string>();
  private readonly verified = new Map<ModelKey, boolean>();

  constructor(
    readonly dir: string,
    private readonly threads = Math.max(1, availableParallelism() - 1),
  ) {
    const mf = join(dir, 'manifest.json');
    this.manifest = existsSync(mf) ? (JSON.parse(readFileSync(mf, 'utf8')) as { models: ModelEntry[] }).models : [];
  }

  status(): ModelStatus[] {
    return this.manifest.map((m) => {
      const installed = existsSync(join(this.dir, m.file));
      return {
        key: m.key,
        file: m.file,
        sha256: m.sha256,
        name: m.name,
        licence: m.licence,
        purpose: m.purpose,
        installed,
        verified: this.verified.get(m.key) ?? false,
        loaded: this.sessions.has(m.key) && !this.errors.has(m.key),
        error: this.errors.get(m.key) ?? (installed ? null : 'not installed — run "npm run models:fetch" or copy the models folder'),
      };
    });
  }

  available(key: ModelKey): boolean {
    const m = this.manifest.find((x) => x.key === key);
    return Boolean(m && existsSync(join(this.dir, m.file)) && !this.errors.has(key));
  }

  private session(key: ModelKey): Promise<ort.InferenceSession> {
    let s = this.sessions.get(key);
    if (!s) {
      s = (async () => {
        const m = this.manifest.find((x) => x.key === key);
        if (!m) throw new ModelUnavailable(`model "${key}" is not in the manifest`);
        const file = join(this.dir, m.file);
        if (!existsSync(file)) throw new ModelUnavailable(`model "${m.name}" is not installed (${m.file})`);
        const bytes = readFileSync(file);
        const h = createHash('sha256').update(bytes).digest('hex');
        if (h !== m.sha256) throw new ModelUnavailable(`model "${m.name}" failed integrity check (SHA-256 mismatch) — refusing to load`);
        this.verified.set(key, true);
        return ort.InferenceSession.create(bytes, { intraOpNumThreads: this.threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', logSeverityLevel: 3 });
      })();
      s.catch((e: unknown) => this.errors.set(key, e instanceof Error ? e.message : String(e)));
      this.sessions.set(key, s);
    }
    return s;
  }

  // -------------------------------------------------------------------------------------------------------
  // Objects

  private async detectOnce(img: RgbImage, scoreThr: number): Promise<Detection[]> {
    const s = await this.session('detector');
    const lb = letterboxBgr(img, 640, 114);
    const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', lb.tensor, [1, 3, 640, 640]) });
    return decodeYolox(out[s.outputNames[0]!]!.data as Float32Array, 640, lb.ratio, scoreThr);
  }

  /**
   * Object detection. With `tiled`, the frame is also analysed in overlapping native-resolution tiles so
   * small/distant people and vehicles are found (≈ SAHI); results are merged by NMS.
   */
  async detect(img: RgbImage, o: { scoreThr?: number; tiled?: boolean; allClasses?: boolean } = {}): Promise<Detection[]> {
    const thr = o.scoreThr ?? 0.35;
    let dets = await this.detectOnce(img, thr);
    if (o.tiled && Math.max(img.width, img.height) > 900) {
      for (const t of tiles(img.width, img.height, 640, 96)) {
        const sub = await this.detectOnce(cropRgb(img, t.x, t.y, t.w, t.h), thr);
        // Tiles contribute only small, uncut objects; anything large or clipped by an interior tile edge is
        // the full-frame pass's job (otherwise half-objects become false boxes).
        for (const d of sub) if (!cutByTile(d, t, img.width, img.height) && d.w < t.w * 0.5 && d.h < t.h * 0.5) dets.push({ ...d, x: d.x + t.x, y: d.y + t.y });
      }
      dets = nms(dets, 0.5);
    }
    return o.allClasses ? dets : dets.filter((d) => SECURITY_CLASSES.has(d.label));
  }

  // -------------------------------------------------------------------------------------------------------
  // Faces

  private async facesOnce(img: RgbImage, scoreThr: number): Promise<FaceDetection[]> {
    const s = await this.session('face_detector');
    const lb = letterboxBgr(img, 640, 0);
    const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', lb.tensor, [1, 3, 640, 640]) });
    const arrays: Record<string, Float32Array> = {};
    for (const k of s.outputNames) arrays[k] = out[k]!.data as Float32Array;
    return decodeYunet(arrays, 640, lb.ratio, scoreThr);
  }

  /** Face detection, multi-scale: whole frame plus native-resolution tiles for small faces in large frames. */
  async detectFaces(img: RgbImage, o: { scoreThr?: number; tiled?: boolean } = {}): Promise<FaceDetection[]> {
    const thr = o.scoreThr ?? 0.6;
    let faces = await this.facesOnce(img, thr);
    if ((o.tiled ?? true) && Math.max(img.width, img.height) > 900) {
      for (const t of tiles(img.width, img.height, 640, 128)) {
        const sub = (await this.facesOnce(cropRgb(img, t.x, t.y, t.w, t.h), thr)).filter((f) => !cutByTile(f, t, img.width, img.height));
        for (const f of sub) faces.push({ ...f, x: f.x + t.x, y: f.y + t.y, landmarks: f.landmarks.map(([x, y]) => [x + t.x, y + t.y]) });
      }
      faces = nms(faces, 0.3, false);
    }
    return faces;
  }

  async embedFace(img: RgbImage, face: FaceDetection): Promise<FaceResult> {
    const aligned = alignFace(img, face.landmarks);
    const quality = faceQuality(face, aligned);
    if (quality.grade === 'UNUSABLE') return { face, quality, embedding: null, aligned };
    const s = await this.session('face_embedder');
    const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', toChwRgb255(aligned), [1, 3, 112, 112]) });
    const emb = l2normalize(out[s.outputNames[0]!]!.data as Float32Array);
    return { face, quality, embedding: Array.from(emb, (v) => Math.round(v * 1e6) / 1e6), aligned };
  }

  async faces(img: RgbImage, o: { scoreThr?: number; tiled?: boolean; max?: number } = {}): Promise<FaceResult[]> {
    const dets = (await this.detectFaces(img, o)).sort((a, b) => b.w * b.h - a.w * a.h).slice(0, o.max ?? 50);
    const res: FaceResult[] = [];
    for (const f of dets) res.push(await this.embedFace(img, f));
    return res;
  }

  // -------------------------------------------------------------------------------------------------------
  // Generative 4× upscaling (AI-INFERRED). 128×128 tiles with overlap, feather-blended.

  async upscale4x(img: RgbImage, onProgress?: (f: number) => void): Promise<RgbImage> {
    const s = await this.session('super_resolution');
    const T = 128;
    const ov = 16;
    const S = 4;
    const out = makeRgb(img.width * S, img.height * S);
    const wsum = new Float32Array(img.width * S * img.height * S);
    const ts = tiles(img.width, img.height, T, ov, true);
    let done = 0;
    for (const t of ts) {
      const tile = cropRgb(img, t.x, t.y, T, T); // edge-clamped when the image is smaller than a tile
      const plane = T * T;
      const inp = new Float32Array(3 * plane);
      for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) inp[c * plane + i] = tile.data[i * 3 + c]!;
      const r = await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', inp, [1, 3, T, T]) });
      const o = r[s.outputNames[0]!]!.data as Float32Array;
      const OT = T * S;
      for (let y = 0; y < OT; y++) {
        const gy = t.y * S + y;
        if (gy >= out.height) break;
        const wy = feather(y, OT, ov * S, t.y > 0, t.y + T < img.height);
        for (let x = 0; x < OT; x++) {
          const gx = t.x * S + x;
          if (gx >= out.width) break;
          const wt = wy * feather(x, OT, ov * S, t.x > 0, t.x + T < img.width);
          const gi = gy * out.width + gx;
          for (let c = 0; c < 3; c++) out.data[gi * 3 + c]! += Math.min(1, Math.max(0, o[c * OT * OT + y * OT + x]!)) * wt;
          wsum[gi]! += wt;
        }
      }
      onProgress?.(++done / ts.length);
    }
    for (let i = 0; i < wsum.length; i++) for (let c = 0; c < 3; c++) out.data[i * 3 + c] = out.data[i * 3 + c]! / Math.max(1e-6, wsum[i]!);
    return out;
  }
}

/** True when a tile-local box touches a tile edge that is not also an image edge. */
function cutByTile(b: { x: number; y: number; w: number; h: number }, t: { x: number; y: number; w: number; h: number }, W: number, H: number): boolean {
  const m = 2;
  return (b.x <= m && t.x > 0) || (b.y <= m && t.y > 0) || (b.x + b.w >= t.w - m && t.x + t.w < W) || (b.y + b.h >= t.h - m && t.y + t.h < H);
}

function feather(i: number, n: number, ramp: number, rampStart: boolean, rampEnd: boolean): number {
  let w = 1;
  if (rampStart && i < ramp) w = Math.min(w, (i + 0.5) / ramp);
  if (rampEnd && i > n - ramp) w = Math.min(w, (n - i - 0.5) / ramp);
  return Math.max(1e-3, w);
}

/** Overlapping tiles covering a w×h image. `exact` keeps tiles exactly `size` (may extend past the edge). */
export function tiles(w: number, h: number, size: number, overlap: number, exact = false): { x: number; y: number; w: number; h: number }[] {
  const step = size - overlap;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = 0; ; x += step) {
    xs.push(Math.max(0, Math.min(x, exact ? x : w - size)));
    if (x + size >= w) break;
  }
  for (let y = 0; ; y += step) {
    ys.push(Math.max(0, Math.min(y, exact ? y : h - size)));
    if (y + size >= h) break;
  }
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const y of [...new Set(ys)]) for (const x of [...new Set(xs)]) out.push({ x, y, w: Math.min(size, w - x), h: Math.min(size, h - y) });
  return out;
}
