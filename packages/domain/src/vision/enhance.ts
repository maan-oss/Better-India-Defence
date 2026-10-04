/**
 * Image restoration operators for the forensic enhancement workbench.
 *
 * Every operator here is a published, deterministic method whose output is a function of the input pixels
 * and the stated parameters only — no learned prior, nothing invented. Their outputs are labelled RESTORED.
 * (Multi-frame fusion is MULTI-OBSERVATION; the generative upscaler lives server-side and is AI-INFERRED.)
 *
 * References:
 *  - Guided filter: He, Sun, Tang, "Guided Image Filtering", TPAMI 2013.
 *  - Noise estimate: Immerkær, "Fast Noise Variance Estimation", CVIU 1996.
 *  - Dark channel prior: He, Sun, Tang, "Single Image Haze Removal Using Dark Channel Prior", TPAMI 2011.
 *  - Low-light: Guo, Li, Ling, "LIME: Low-Light Image Enhancement via Illumination Map Estimation", TIP 2017
 *    (illumination = max-RGB refined by an edge-preserving filter; simplified, no optimisation).
 *  - CLAHE: Zuiderveld, "Contrast Limited Adaptive Histogram Equalization", Graphics Gems IV, 1994.
 *  - Richardson–Lucy deconvolution: Richardson 1972; Lucy 1974.
 */
import {
  type Plane,
  type RgbImage,
  clamp01,
  cloneRgb,
  convolveSeparable,
  estimateNoiseSigma,
  fromPlanes,
  gaussianPlane,
  guidedFilter,
  laplacianVariance,
  luma,
  makePlane,
  makeRgb,
  mergeYCbCr,
  minFilter,
  resizeRgb,
  splitYCbCr,
} from './rgb.ts';

export const PRODUCT_STATES = ['ORIGINAL', 'RESTORED', 'MULTI-OBSERVATION', 'AI-INFERRED'] as const;
export type ProductState = (typeof PRODUCT_STATES)[number];

/** Combine provenance: a product is as "derived" as its most derived step. */
export const worstState = (a: ProductState, b: ProductState): ProductState => (PRODUCT_STATES.indexOf(a) >= PRODUCT_STATES.indexOf(b) ? a : b);

export interface ImageStats {
  width: number;
  height: number;
  /** Estimated noise σ (0–1 intensity). */
  noiseSigma: number;
  /** Variance of Laplacian ×1e4 — focus measure. */
  sharpness: number;
  meanLuma: number;
  /** Fraction of pixels within 2% of black / white. */
  clippedDark: number;
  clippedBright: number;
  /** RMS contrast of luma. */
  contrast: number;
}

export function imageStats(img: RgbImage): ImageStats {
  const y = luma(img);
  let s = 0;
  let s2 = 0;
  let dark = 0;
  let bright = 0;
  for (const v of y.data) {
    s += v;
    s2 += v * v;
    if (v < 0.02) dark++;
    if (v > 0.98) bright++;
  }
  const n = y.data.length;
  const m = s / n;
  return {
    width: img.width,
    height: img.height,
    noiseSigma: round(estimateNoiseSigma(y), 4),
    sharpness: round(laplacianVariance(y) * 1e4, 2),
    meanLuma: round(m, 3),
    clippedDark: round(dark / n, 4),
    clippedBright: round(bright / n, 4),
    contrast: round(Math.sqrt(Math.max(0, s2 / n - m * m)), 4),
  };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Suggest operators from measured image statistics (used by the "auto" button; operators still explicit). */
export function suggestOperations(st: ImageStats): EnhanceOp[] {
  const ops: EnhanceOp[] = [];
  if (st.meanLuma < 0.22) ops.push({ op: 'low_light', strength: st.meanLuma < 0.12 ? 0.8 : 0.5 });
  if (st.noiseSigma > 0.012) ops.push({ op: 'denoise', strength: Math.min(1, st.noiseSigma / 0.04) });
  if (st.contrast < 0.12 && st.meanLuma >= 0.22) ops.push({ op: 'dehaze', strength: 0.7 });
  ops.push({ op: 'clahe', clipLimit: 2, tiles: 8 });
  if (st.sharpness < 5) ops.push({ op: 'sharpen', amount: 0.8, radius: 1.2 });
  return ops;
}

// ---------------------------------------------------------------------------------------------------------

export type EnhanceOp =
  | { op: 'denoise'; strength: number }
  | { op: 'sharpen'; amount: number; radius: number }
  | { op: 'clahe'; clipLimit: number; tiles: number }
  | { op: 'dehaze'; strength: number }
  | { op: 'low_light'; strength: number }
  | { op: 'deblur'; psf: 'gaussian'; sigma: number; iterations: number }
  | { op: 'deblur'; psf: 'motion'; length: number; angleDeg: number; iterations: number }
  | { op: 'white_balance' }
  | { op: 'levels'; lowPct: number; highPct: number }
  | { op: 'gamma'; gamma: number }
  | { op: 'upscale'; factor: number }
  | { op: 'grayscale' }
  | { op: 'crop'; x: number; y: number; w: number; h: number };

export const OP_DESCRIPTIONS: Record<EnhanceOp['op'], string> = {
  denoise: 'Edge-preserving noise reduction (guided filter; luma by measured noise level, chroma more strongly).',
  sharpen: 'Unsharp mask on luma. Increases edge contrast; does not add resolution.',
  clahe: 'Contrast-limited adaptive histogram equalisation on luma. Reveals detail in shadows and highlights.',
  dehaze: 'Haze, smoke and fog removal (dark channel prior with guided-filter transmission refinement).',
  low_light: 'Low-light enhancement: illumination estimated from max-RGB, refined, then compensated.',
  deblur: 'Richardson–Lucy deconvolution for a known blur (defocus ≈ Gaussian, or linear motion).',
  white_balance: 'Grey-world white balance (removes colour cast from sodium/LED lighting).',
  levels: 'Percentile levels stretch.',
  gamma: 'Gamma adjustment.',
  upscale: 'Bicubic interpolation. Makes the image larger, not more detailed.',
  grayscale: 'Convert to luma.',
  crop: 'Region of interest.',
};

export function applyOp(img: RgbImage, o: EnhanceOp): RgbImage {
  switch (o.op) {
    case 'denoise':
      return denoise(img, o.strength);
    case 'sharpen':
      return sharpen(img, o.amount, o.radius);
    case 'clahe':
      return clahe(img, o.clipLimit, o.tiles);
    case 'dehaze':
      return dehaze(img, o.strength);
    case 'low_light':
      return lowLight(img, o.strength);
    case 'deblur':
      return o.psf === 'gaussian' ? deblur(img, gaussianPsf(o.sigma), o.iterations) : deblur(img, motionPsf(o.length, o.angleDeg), o.iterations);
    case 'white_balance':
      return whiteBalance(img);
    case 'levels':
      return levels(img, o.lowPct, o.highPct);
    case 'gamma':
      return gamma(img, o.gamma);
    case 'upscale':
      return resizeRgb(img, Math.round(img.width * o.factor), Math.round(img.height * o.factor));
    case 'grayscale': {
      const y = luma(img);
      return fromPlanes(y, y, y);
    }
    case 'crop':
      return cropClamped(img, o.x, o.y, o.w, o.h);
  }
}

function cropClamped(img: RgbImage, x: number, y: number, w: number, h: number): RgbImage {
  const x0 = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const cw = Math.max(1, Math.min(img.width - x0, Math.round(w)));
  const ch = Math.max(1, Math.min(img.height - y0, Math.round(h)));
  const out = makeRgb(cw, ch);
  for (let yy = 0; yy < ch; yy++) out.data.set(img.data.subarray(((y0 + yy) * img.width + x0) * 3, ((y0 + yy) * img.width + x0 + cw) * 3), yy * cw * 3);
  return out;
}

export function denoise(img: RgbImage, strength: number): RgbImage {
  const { y, cb, cr } = splitYCbCr(img);
  const sigma = Math.max(0.003, estimateNoiseSigma(y));
  const s = Math.max(0, Math.min(1.5, strength));
  // Smooth where local variance is comparable to the noise variance; preserve structure well above it.
  const eps = (sigma * (1 + 1.5 * s)) ** 2;
  const r = 1 + Math.round(s * 2);
  const y2 = guidedFilter(y, y, r, eps);
  const cb2 = guidedFilter(y2, cb, r + 1, eps * 2);
  const cr2 = guidedFilter(y2, cr, r + 1, eps * 2);
  return mergeYCbCr(y2, cb2, cr2);
}

export function sharpen(img: RgbImage, amount: number, radius: number): RgbImage {
  const { y, cb, cr } = splitYCbCr(img);
  const blur = gaussianPlane(y, Math.max(0.3, radius));
  const out = makePlane(y.width, y.height);
  for (let i = 0; i < y.data.length; i++) out.data[i] = clamp01(y.data[i]! + amount * (y.data[i]! - blur.data[i]!));
  return mergeYCbCr(out, cb, cr);
}

export function clahePlane(p: Plane, clipLimit: number, tiles: number): Plane {
  const { width: w, height: h } = p;
  const tx = Math.max(1, Math.min(tiles, Math.floor(w / 8)));
  const ty = Math.max(1, Math.min(tiles, Math.floor(h / 8)));
  const bins = 256;
  const maps: Float32Array[] = [];
  for (let j = 0; j < ty; j++)
    for (let i = 0; i < tx; i++) {
      const x0 = Math.floor((i * w) / tx);
      const x1 = Math.floor(((i + 1) * w) / tx);
      const y0 = Math.floor((j * h) / ty);
      const y1 = Math.floor(((j + 1) * h) / ty);
      const hist = new Float64Array(bins);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[Math.min(bins - 1, Math.floor(p.data[y * w + x]! * bins))]!++;
      const n = (x1 - x0) * (y1 - y0);
      const limit = Math.max(1, (clipLimit * n) / bins);
      let excess = 0;
      for (let b = 0; b < bins; b++)
        if (hist[b]! > limit) {
          excess += hist[b]! - limit;
          hist[b] = limit;
        }
      const add = excess / bins;
      const map = new Float32Array(bins);
      let cum = 0;
      for (let b = 0; b < bins; b++) {
        cum += hist[b]! + add;
        map[b] = cum / n;
      }
      maps.push(map);
    }
  const out = makePlane(w, h);
  for (let y = 0; y < h; y++) {
    const gy = (y + 0.5) / (h / ty) - 0.5;
    const j0 = Math.max(0, Math.min(ty - 1, Math.floor(gy)));
    const j1 = Math.min(ty - 1, j0 + 1);
    const fy = Math.max(0, Math.min(1, gy - j0));
    for (let x = 0; x < w; x++) {
      const gx = (x + 0.5) / (w / tx) - 0.5;
      const i0 = Math.max(0, Math.min(tx - 1, Math.floor(gx)));
      const i1 = Math.min(tx - 1, i0 + 1);
      const fx = Math.max(0, Math.min(1, gx - i0));
      const b = Math.min(bins - 1, Math.floor(p.data[y * w + x]! * bins));
      const v00 = maps[j0 * tx + i0]![b]!;
      const v01 = maps[j0 * tx + i1]![b]!;
      const v10 = maps[j1 * tx + i0]![b]!;
      const v11 = maps[j1 * tx + i1]![b]!;
      out.data[y * w + x] = (v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy;
    }
  }
  return out;
}

export function clahe(img: RgbImage, clipLimit: number, tiles: number): RgbImage {
  const { y, cb, cr } = splitYCbCr(img);
  const y2 = clahePlane(y, clipLimit, tiles);
  // Keep chroma proportional to the luma change so colours do not wash out.
  const n = y.data.length;
  for (let i = 0; i < n; i++) {
    const k = y.data[i]! > 1e-3 ? Math.min(3, y2.data[i]! / y.data[i]!) : 1;
    cb.data[i] = cb.data[i]! * Math.sqrt(k);
    cr.data[i] = cr.data[i]! * Math.sqrt(k);
  }
  return mergeYCbCr(y2, cb, cr);
}

export function dehaze(img: RgbImage, strength: number): RgbImage {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const patch = Math.max(3, Math.round(Math.min(w, h) / 60));
  const minRgb = makePlane(w, h);
  for (let i = 0; i < n; i++) minRgb.data[i] = Math.min(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!);
  const dark = minFilter(minRgb, patch);
  // Atmospheric light: mean colour of the brightest 0.1% of the dark channel.
  const hist = new Uint32Array(1024);
  for (let i = 0; i < n; i++) hist[Math.min(1023, Math.floor(dark.data[i]! * 1024))]!++;
  const want = Math.max(1, Math.floor(n * 0.001));
  let thrBin = 1023;
  for (let acc = 0; thrBin > 0; thrBin--) if ((acc += hist[thrBin]!) >= want) break;
  const thr = thrBin / 1024;
  const A = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < n; i++)
    if (dark.data[i]! >= thr) {
      for (let c = 0; c < 3; c++) A[c]! += data[i * 3 + c]!;
      count++;
    }
  for (let c = 0; c < 3; c++) A[c] = Math.max(0.05, A[c]! / Math.max(1, count));
  const norm = makePlane(w, h);
  for (let i = 0; i < n; i++) norm.data[i] = Math.min(data[i * 3]! / A[0]!, data[i * 3 + 1]! / A[1]!, data[i * 3 + 2]! / A[2]!);
  const darkN = minFilter(norm, patch);
  const omega = 0.95 * Math.max(0, Math.min(1, strength));
  const t = makePlane(w, h);
  for (let i = 0; i < n; i++) t.data[i] = 1 - omega * darkN.data[i]!;
  const tRef = guidedFilter(luma(img), t, Math.max(8, patch * 4), 1e-3);
  const out = makeRgb(w, h);
  for (let i = 0; i < n; i++) {
    const tt = Math.max(0.1, tRef.data[i]!);
    for (let c = 0; c < 3; c++) out.data[i * 3 + c] = clamp01((data[i * 3 + c]! - A[c]!) / tt + A[c]!);
  }
  return out;
}

export function lowLight(img: RgbImage, strength: number): RgbImage {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const L = makePlane(w, h);
  for (let i = 0; i < n; i++) L.data[i] = Math.max(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!);
  const r = Math.max(4, Math.round(Math.min(w, h) / 40));
  const Lr = guidedFilter(L, L, r, 0.002);
  // LIME: R = I / T^γ, γ ∈ [0.5, 0.9] by strength (higher γ → stronger brightening of dark regions).
  const g = 0.5 + 0.4 * Math.max(0, Math.min(1, strength));
  const out = makeRgb(w, h);
  for (let i = 0; i < n; i++) {
    const k = 1 / Math.max(0.03, Lr.data[i]!) ** g;
    for (let c = 0; c < 3; c++) out.data[i * 3 + c] = clamp01(data[i * 3 + c]! * k);
  }
  // Brightening amplifies sensor noise: follow with light denoising scaled to the gain applied.
  return denoise(out, 0.3 * strength);
}

export function whiteBalance(img: RgbImage): RgbImage {
  const n = img.width * img.height;
  const m = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) m[c]! += img.data[i * 3 + c]!;
  const g = (m[0]! + m[1]! + m[2]!) / 3;
  const k = m.map((v) => (v > 0 ? g / v : 1));
  const out = cloneRgb(img);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out.data[i * 3 + c] = clamp01(img.data[i * 3 + c]! * k[c]!);
  return out;
}

export function levels(img: RgbImage, lowPct: number, highPct: number): RgbImage {
  const y = luma(img);
  const sorted = Float32Array.from(y.data).sort();
  const lo = sorted[Math.floor((lowPct / 100) * (sorted.length - 1))]!;
  const hi = sorted[Math.floor((highPct / 100) * (sorted.length - 1))]!;
  const span = Math.max(1e-3, hi - lo);
  const out = cloneRgb(img);
  for (let i = 0; i < out.data.length; i++) out.data[i] = clamp01((img.data[i]! - lo) / span);
  return out;
}

export function gamma(img: RgbImage, g: number): RgbImage {
  const out = cloneRgb(img);
  for (let i = 0; i < out.data.length; i++) out.data[i] = img.data[i]! ** (1 / g);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Deconvolution

export interface Psf {
  width: number;
  height: number;
  data: Float32Array;
  /** 1-D kernel when the PSF is separable and symmetric (Gaussian) — enables an O(N·r) convolution. */
  separable?: Float32Array;
}

export function gaussianPsf(sigma: number): Psf {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const s = 2 * r + 1;
  const data = new Float32Array(s * s);
  let sum = 0;
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) sum += data[(y + r) * s + x + r] = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
  for (let i = 0; i < data.length; i++) data[i] = data[i]! / sum;
  const k1 = new Float32Array(s);
  let s1 = 0;
  for (let i = -r; i <= r; i++) s1 += k1[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < s; i++) k1[i] = k1[i]! / s1;
  return { width: s, height: s, data, separable: k1 };
}

/** Linear motion blur kernel of `length` pixels at `angleDeg` (0° = horizontal), anti-aliased. */
export function motionPsf(length: number, angleDeg: number): Psf {
  const L = Math.max(1, length);
  const r = Math.ceil(L / 2) + 1;
  const s = 2 * r + 1;
  const data = new Float32Array(s * s);
  const a = (angleDeg * Math.PI) / 180;
  const steps = Math.ceil(L * 4);
  for (let k = 0; k <= steps; k++) {
    const t = (k / steps - 0.5) * L;
    const x = r + t * Math.cos(a);
    const y = r - t * Math.sin(a);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const add = (xx: number, yy: number, wt: number) => {
      if (xx >= 0 && yy >= 0 && xx < s && yy < s) data[yy * s + xx]! += wt;
    };
    add(x0, y0, (1 - fx) * (1 - fy));
    add(x0 + 1, y0, fx * (1 - fy));
    add(x0, y0 + 1, (1 - fx) * fy);
    add(x0 + 1, y0 + 1, fx * fy);
  }
  let sum = 0;
  for (const v of data) sum += v;
  for (let i = 0; i < data.length; i++) data[i] = data[i]! / sum;
  return { width: s, height: s, data };
}

function convolve2d(p: Plane, k: Psf, flip = false): Plane {
  if (k.separable) return convolveSeparable(p, k.separable, k.separable); // symmetric: flip is identity
  const { width: w, height: h } = p;
  const rx = (k.width - 1) / 2;
  const ry = (k.height - 1) / 2;
  const taps: { dx: number; dy: number; w: number }[] = [];
  for (let y = 0; y < k.height; y++)
    for (let x = 0; x < k.width; x++) {
      const v = k.data[y * k.width + x]!;
      if (v > 1e-6) taps.push({ dx: flip ? rx - x : x - rx, dy: flip ? ry - y : y - ry, w: v });
    }
  const out = makePlane(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (const t of taps) {
        const xx = Math.min(w - 1, Math.max(0, x - t.dx));
        const yy = Math.min(h - 1, Math.max(0, y - t.dy));
        acc += p.data[yy * w + xx]! * t.w;
      }
      out.data[y * w + x] = acc;
    }
  return out;
}

/** Richardson–Lucy on luma (chroma kept), with a mild noise-adaptive damping to limit ringing. */
export function deblur(img: RgbImage, psf: Psf, iterations: number): RgbImage {
  const { y, cb, cr } = splitYCbCr(img);
  let est = makePlane(y.width, y.height);
  est.data.set(y.data);
  const it = Math.max(1, Math.min(60, Math.round(iterations)));
  for (let i = 0; i < it; i++) {
    const conv = convolve2d(est, psf);
    const ratio = makePlane(y.width, y.height);
    for (let j = 0; j < ratio.data.length; j++) ratio.data[j] = y.data[j]! / Math.max(1e-4, conv.data[j]!);
    const corr = convolve2d(ratio, psf, true);
    const next = makePlane(y.width, y.height);
    for (let j = 0; j < next.data.length; j++) next.data[j] = clamp01(est.data[j]! * corr.data[j]!);
    est = next;
  }
  return mergeYCbCr(est, cb, cr);
}
