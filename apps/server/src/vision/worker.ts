import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { multiFrameReconstruct } from '@strata/domain';
import {
  type Detection,
  type EnhanceOp,
  type ImageStats,
  type Plane,
  type ProductState,
  type RgbImage,
  OP_DESCRIPTIONS,
  applyOp,
  cropRgb,
  imageStats,
  luma,
  makePlane,
  mergeYCbCr,

  resizeRgb,
  splitYCbCr,
  worstState,
} from '@strata/domain/vision';
import { ModelUnavailable, VisionEngine, findModelsDir } from './engine.ts';
import { decodeImage, encodeJpeg, encodePng } from './imageio.ts';
import { frameAt, frames, outputSize, probe } from './video.ts';

/**
 * Vision worker thread. ONNX Runtime and all pixel work run here so the API event loop never stalls.
 * One engine (one set of model sessions) per worker.
 */
const engine = new VisionEngine(findModelsDir(process.env.STRATA_MODELS_DIR));

export interface FaceOut {
  box: { x: number; y: number; w: number; h: number };
  landmarks: [number, number][];
  score: number;
  quality: { interOcularPx: number; yawDeg: number; sharpness: number; detectorScore: number; grade: 'GOOD' | 'FAIR' | 'POOR' | 'UNUSABLE'; reasons: string[] };
  embedding: number[] | null;
  /** 112×112 aligned crop, JPEG. */
  aligned: Uint8Array;
  /** Context crop around the face (≈2× box), JPEG, for operator review. */
  crop: Uint8Array;
}

export interface AnalysisOut {
  width: number;
  height: number;
  sha256: string;
  stats: ImageStats;
  objects: Detection[];
  faces: FaceOut[];
  ms: number;
}

export interface EnhanceStep {
  op: EnhanceOp | { op: 'ai_upscale4x' };
  description: string;
  state: ProductState;
  ms: number;
  sha256After: string;
}

export interface EnhanceOut {
  state: ProductState;
  png: Uint8Array;
  preview: Uint8Array;
  width: number;
  height: number;
  sha256In: string;
  sha256Out: string;
  statsBefore: ImageStats;
  statsAfter: ImageStats;
  steps: EnhanceStep[];
}

export type VisionKinds = {
  status: { input: undefined; output: ReturnType<VisionEngine['status']> };
  analyze_image: { input: { bytes: Uint8Array; objects: boolean; faces: boolean; tiled: boolean; maxFaces?: number }; output: AnalysisOut };
  analyze_video: {
    input: { path: string; fps: number; startS: number; durationS: number; maxWidth: number; objects: boolean; faces: boolean; tiled: boolean };
    output: { info: ReturnType<typeof probe>; frames: (Omit<AnalysisOut, 'sha256' | 'stats'> & { tS: number; thumb: Uint8Array | null })[] };
  };
  probe_video: { input: { path: string }; output: ReturnType<typeof probe> };
  frame: { input: { path: string; tS: number; maxWidth: number; format: 'jpeg' | 'png' }; output: { bytes: Uint8Array; width: number; height: number; sha256: string } };
  enhance: { input: { bytes: Uint8Array; ops: EnhanceOp[]; aiUpscale: boolean }; output: EnhanceOut };
  multi_frame: {
    input: { path: string; tS: number; frames: number; fps: number; roi: { x: number; y: number; w: number; h: number }; scale: number; searchPx: number };
    output: { png: Uint8Array; preview: Uint8Array; reference: Uint8Array; width: number; height: number; usedFrames: number; rejectedFrames: number; shifts: { dx: number; dy: number }[]; sha256Out: string };
  };
};

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function analyze(img: RgbImage, o: { objects: boolean; faces: boolean; tiled: boolean; maxFaces?: number }): Promise<Omit<AnalysisOut, 'sha256' | 'stats'>> {
  const t0 = performance.now();
  const objects = o.objects ? await engine.detect(img, { tiled: o.tiled }) : [];
  const faces: FaceOut[] = [];
  if (o.faces) {
    for (const r of await engine.faces(img, { tiled: o.tiled, max: o.maxFaces ?? 40 })) {
      const pad = Math.max(r.face.w, r.face.h) * 0.6;
      const cx = Math.max(0, Math.round(r.face.x - pad));
      const cy = Math.max(0, Math.round(r.face.y - pad));
      const cw = Math.min(img.width - cx, Math.round(r.face.w + 2 * pad));
      const ch = Math.min(img.height - cy, Math.round(r.face.h + 2 * pad));
      let crop = cropRgb(img, cx, cy, Math.max(1, cw), Math.max(1, ch));
      if (crop.width < 160) crop = resizeRgb(crop, 160, Math.round((crop.height * 160) / crop.width)); // display only; bicubic
      faces.push({
        box: { x: round1(r.face.x), y: round1(r.face.y), w: round1(r.face.w), h: round1(r.face.h) },
        landmarks: r.face.landmarks.map(([x, y]) => [round1(x), round1(y)]),
        score: r.face.score,
        quality: r.quality,
        embedding: r.embedding,
        aligned: encodeJpeg(r.aligned, 95),
        crop: encodeJpeg(crop, 90),
      });
    }
  }
  return { width: img.width, height: img.height, objects: objects.map((d) => ({ ...d, x: round1(d.x), y: round1(d.y), w: round1(d.w), h: round1(d.h), score: Math.round(d.score * 1000) / 1000 })), faces, ms: Math.round(performance.now() - t0) };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function grayToPlane(g: { width: number; height: number; data: Float32Array }): Plane {
  return { width: g.width, height: g.height, data: g.data };
}

/** Integer shift of `img` best matching `ref` around the ROI (normalised cross-correlation on luma). */
function coarseAlign(ref: Plane, img: Plane, roi: { x: number; y: number; w: number; h: number }, R: number): { dx: number; dy: number } {
  let best = -Infinity;
  let bd = { dx: 0, dy: 0 };
  const step = Math.max(1, Math.floor(Math.max(roi.w, roi.h) / 48));
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      let n = 0;
      for (let y = roi.y; y < roi.y + roi.h; y += step)
        for (let x = roi.x; x < roi.x + roi.w; x += step) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height || x >= ref.width || y >= ref.height) continue;
          const a = ref.data[y * ref.width + x]!;
          const b = img.data[yy * img.width + xx]!;
          sa += a;
          sb += b;
          saa += a * a;
          sbb += b * b;
          sab += a * b;
          n++;
        }
      if (n < 16) continue;
      const cov = sab - (sa * sb) / n;
      const den = Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n)) || 1;
      const ncc = cov / den;
      if (ncc > best) {
        best = ncc;
        bd = { dx, dy };
      }
    }
  return bd;
}

function cropPlane(p: Plane, x0: number, y0: number, w: number, h: number): Plane {
  const out = makePlane(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out.data[y * w + x] = p.data[Math.min(p.height - 1, Math.max(0, y0 + y)) * p.width + Math.min(p.width - 1, Math.max(0, x0 + x))]!;
  return out;
}

const handlers: { [N in keyof VisionKinds]: (input: VisionKinds[N]['input']) => Promise<VisionKinds[N]['output']> } = {
  status: async () => engine.status(),

  analyze_image: async (i) => {
    const img = decodeImage(i.bytes);
    const r = await analyze(img, i);
    return { ...r, sha256: sha(i.bytes), stats: imageStats(img) };
  },

  probe_video: async (i) => probe(i.path),

  analyze_video: async (i) => {
    const info = probe(i.path);
    const size = outputSize(info, i.maxWidth);
    const out: VisionKinds['analyze_video']['output']['frames'] = [];
    for await (const f of frames(i.path, size, { fps: i.fps, startS: i.startS, durationS: i.durationS })) {
      const r = await analyze(f.image, i);
      const interesting = r.objects.some((d) => d.category === 'person' || d.category === 'vehicle' || d.category === 'aircraft') || r.faces.length > 0;
      out.push({ ...r, tS: Math.round(f.tS * 1000) / 1000, thumb: interesting ? encodeJpeg(resizeRgb(f.image, 320, Math.round((f.image.height * 320) / f.image.width)), 80) : null });
    }
    return { info, frames: out };
  },

  frame: async (i) => {
    const img = frameAt(i.path, i.tS, i.maxWidth);
    const bytes = i.format === 'png' ? encodePng(img) : encodeJpeg(img, 92);
    return { bytes, width: img.width, height: img.height, sha256: sha(bytes) };
  },

  enhance: async (i) => {
    const input = decodeImage(i.bytes);
    let img = input;
    let state: ProductState = 'ORIGINAL';
    const steps: EnhanceStep[] = [];
    for (const op of i.ops) {
      const t = performance.now();
      if ((op.op === 'deblur' || op.op === 'dehaze' || op.op === 'low_light' || op.op === 'denoise') && img.width * img.height > 8_400_000) throw new Error('image too large for this operation (max ≈ 8 MP); crop a region of interest first');
      img = applyOp(img, op);
      const s: ProductState = op.op === 'crop' || op.op === 'grayscale' ? 'ORIGINAL' : 'RESTORED';
      state = worstState(state, s);
      steps.push({ op, description: OP_DESCRIPTIONS[op.op], state: s, ms: Math.round(performance.now() - t), sha256After: sha(new Uint8Array(img.data.buffer)) });
    }
    if (i.aiUpscale) {
      if (img.width * img.height > 512 * 512) throw new Error('AI upscaling is limited to regions up to 512×512 px; crop a region of interest first');
      const t = performance.now();
      img = await engine.upscale4x(img);
      state = 'AI-INFERRED';
      steps.push({
        op: { op: 'ai_upscale4x' },
        description: 'Real-ESRGAN 4× generative upscaling. Detail is predicted by a neural network trained on other images and may be invented. Not usable for identification.',
        state: 'AI-INFERRED',
        ms: Math.round(performance.now() - t),
        sha256After: sha(new Uint8Array(img.data.buffer)),
      });
    }
    const png = encodePng(img);
    const prevImg = img.width > 1600 ? resizeRgb(img, 1600, Math.round((img.height * 1600) / img.width)) : img;
    return { state, png, preview: encodeJpeg(prevImg, 90), width: img.width, height: img.height, sha256In: sha(i.bytes), sha256Out: sha(png), statsBefore: imageStats(input), statsAfter: imageStats(img), steps };
  },

  multi_frame: async (i) => {
    const info = probe(i.path);
    const size = { w: info.width - (info.width % 2), h: info.height - (info.height % 2) };
    const start = Math.max(0, i.tS - (i.frames - 1) / (2 * i.fps));
    const lumas: Plane[] = [];
    let refColor: RgbImage | null = null;
    for await (const f of frames(i.path, size, { fps: i.fps, startS: start, durationS: i.frames / i.fps + 0.01 })) {
      lumas.push(luma(f.image));
      if (!refColor && lumas.length === Math.ceil(i.frames / 2)) refColor = f.image;
      if (lumas.length >= i.frames) break;
    }
    if (lumas.length < 2 || !refColor) throw new Error('not enough frames decoded around that time');
    const ref = lumas[Math.ceil(i.frames / 2) - 1]!;
    const roi = { x: Math.max(0, Math.round(i.roi.x)), y: Math.max(0, Math.round(i.roi.y)), w: Math.round(i.roi.w), h: Math.round(i.roi.h) };
    if (roi.w < 8 || roi.h < 8 || roi.w * roi.h > 200 * 200) throw new Error('region of interest must be between 8×8 and 200×200 source pixels');
    const shifts = lumas.map((l) => (l === ref ? { dx: 0, dy: 0 } : coarseAlign(ref, l, roi, i.searchPx)));
    // Reference crop first (multiFrameReconstruct registers relative to frames[0]).
    const order = [lumas.indexOf(ref), ...lumas.map((_, k) => k).filter((k) => k !== lumas.indexOf(ref))];
    const crops = order.map((k) => cropPlane(lumas[k]!, roi.x + shifts[k]!.dx, roi.y + shifts[k]!.dy, roi.w, roi.h));
    const r = multiFrameReconstruct(crops, i.scale, 20, 0.45 * i.scale);
    // Colour: chroma from the reference frame (bicubic) over the multi-frame luma.
    const refCrop = cropRgb(refColor, roi.x, roi.y, roi.w, roi.h);
    const big = resizeRgb(refCrop, roi.w * i.scale, roi.h * i.scale);
    const { cb, cr } = splitYCbCr(big);
    const out = mergeYCbCr(grayToPlane(r.hr), cb, cr);
    const png = encodePng(out);
    return {
      png,
      preview: encodeJpeg(out, 92),
      reference: encodeJpeg(resizeRgb(refCrop, roi.w * i.scale, roi.h * i.scale), 92),
      width: out.width,
      height: out.height,
      usedFrames: r.usedFrames.length,
      rejectedFrames: r.rejectedFrames.length,
      shifts: order.map((k, j) => ({ dx: shifts[k]!.dx + (r.registrations[j]?.dx ?? 0), dy: shifts[k]!.dy + (r.registrations[j]?.dy ?? 0) })),
      sha256Out: sha(png),
    };
  },
};

parentPort?.on('message', (job: { id: number; kind: keyof VisionKinds; input: never }) => {
  const h = handlers[job.kind] as (input: unknown) => Promise<unknown>;
  h(job.input)
    .then((result) => parentPort!.postMessage({ id: job.id, ok: true, result }))
    .catch((e: unknown) => parentPort!.postMessage({ id: job.id, ok: false, error: e instanceof ModelUnavailable ? `MODEL_UNAVAILABLE: ${e.message}` : e instanceof Error ? e.message : String(e) }));
});
