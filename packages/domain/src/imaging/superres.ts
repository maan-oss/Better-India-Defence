import { gaussianBlur, makeGray, sampleBilinear, type Gray, upscaleNearest, resize, unsharp, meanStd } from './raster.ts';

/**
 * Evidence-backed multi-observation reconstruction (classical multi-frame super-resolution).
 *
 * 1. Registration: each low-resolution (LR) crop is aligned to a reference with integer search + iterative
 *    Lucas–Kanade translation refinement (sub-pixel).
 * 2. Fusion: Iterative Back-Projection (Irani & Peleg, 1991) with a Gaussian PSF model: the high-resolution
 *    estimate is repeatedly corrected so that, when re-degraded, it reproduces every captured frame.
 *
 * Every output pixel is a function of captured pixels only. No learned prior, no generated detail.
 * The improvement achievable is bounded by the number of frames, their sub-pixel diversity and noise
 * (roughly √N noise reduction, and up to the sampling limit of the optics) — not "1000×".
 */

export interface Registration {
  dx: number;
  dy: number;
  /** Residual RMS after alignment; large values mean registration failed and the frame should be rejected. */
  residual: number;
}

function ssd(ref: Gray, img: Gray, dx: number, dy: number, border: number): number {
  let s = 0;
  let n = 0;
  for (let y = border; y < ref.height - border; y++)
    for (let x = border; x < ref.width - border; x++) {
      const d = ref.data[y * ref.width + x]! - sampleBilinear(img, x + dx, y + dy);
      s += d * d;
      n++;
    }
  return n ? s / n : Infinity;
}

/** Estimate translation (dx, dy) such that img(x + dx, y + dy) ≈ ref(x, y). */
export function registerTranslation(ref: Gray, img: Gray, maxShift = 3): Registration {
  const border = maxShift;
  let best = { dx: 0, dy: 0, e: Infinity };
  for (let dy = -maxShift; dy <= maxShift; dy++)
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      const e = ssd(ref, img, dx, dy, border);
      if (e < best.e) best = { dx, dy, e };
    }
  let { dx, dy } = best;
  // Lucas–Kanade refinement.
  for (let iter = 0; iter < 12; iter++) {
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let y = border; y < ref.height - border; y++)
      for (let x = border; x < ref.width - border; x++) {
        const gx = (sampleBilinear(img, x + dx + 0.5, y + dy) - sampleBilinear(img, x + dx - 0.5, y + dy));
        const gy = (sampleBilinear(img, x + dx, y + dy + 0.5) - sampleBilinear(img, x + dx, y + dy - 0.5));
        const e = ref.data[y * ref.width + x]! - sampleBilinear(img, x + dx, y + dy);
        a11 += gx * gx;
        a12 += gx * gy;
        a22 += gy * gy;
        b1 += gx * e;
        b2 += gy * e;
      }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12) break;
    const ux = (a22 * b1 - a12 * b2) / det;
    const uy = (a11 * b2 - a12 * b1) / det;
    dx += Math.max(-0.5, Math.min(0.5, ux));
    dy += Math.max(-0.5, Math.min(0.5, uy));
    if (Math.hypot(ux, uy) < 0.002) break;
  }
  return { dx, dy, residual: Math.sqrt(ssd(ref, img, dx, dy, border)) };
}

/** Forward model: HR image → LR observation with shift (LR px), Gaussian PSF and decimation by `s`. */
export function degrade(hr: Gray, s: number, dx: number, dy: number, psfSigmaHr: number): Gray {
  const blurred = gaussianBlur(hr, psfSigmaHr);
  const w = Math.floor(hr.width / s);
  const h = Math.floor(hr.height / s);
  const out = makeGray(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // LR pixel (x, y) of a frame shifted by (dx, dy) samples the HR scene at ((x + dx + 0.5)·s − 0.5).
      out.data[y * w + x] = sampleBilinear(blurred, (x + dx + 0.5) * s - 0.5, (y + dy + 0.5) * s - 0.5);
    }
  return out;
}

export interface MultiFrameResult {
  hr: Gray;
  registrations: Registration[];
  usedFrames: number[];
  rejectedFrames: number[];
  iterations: number;
}

/**
 * Iterative back-projection. `frames` are equally sized LR crops of the same surface.
 * Registration is relative to frames[0].
 */
export function multiFrameReconstruct(frames: Gray[], scale = 4, iterations = 25, psfSigmaHr = 0.45 * 4): MultiFrameResult {
  if (frames.length === 0) throw new Error('no frames');
  const ref = frames[0]!;
  const registrations = frames.map((f, i) => (i === 0 ? { dx: 0, dy: 0, residual: 0 } : registerTranslation(ref, f)));
  const noise = Math.max(0.01, meanStd(ref).std * 0.5);
  const used: number[] = [];
  const rejected: number[] = [];
  registrations.forEach((r, i) => (r.residual < noise * 3 + 0.05 ? used.push(i) : rejected.push(i)));
  // Initial estimate: shift-and-add mean of registered frames, upsampled.
  let hr = resize(ref, ref.width * scale, ref.height * scale);
  const W = hr.width;
  const H = hr.height;
  for (let it = 0; it < iterations; it++) {
    const corr = new Float32Array(W * H);
    const wsum = new Float32Array(W * H);
    for (const i of used) {
      const r = registrations[i]!;
      // Frame i observes the scene shifted by −(dx, dy) relative to the reference.
      const sim = degrade(hr, scale, -r.dx, -r.dy, psfSigmaHr);
      const f = frames[i]!;
      for (let y = 0; y < f.height; y++)
        for (let x = 0; x < f.width; x++) {
          const e = f.data[y * f.width + x]! - sim.data[y * sim.width + x]!;
          // Back-project the error onto the HR footprint of this LR pixel.
          const cx = (x - r.dx + 0.5) * scale - 0.5;
          const cy = (y - r.dy + 0.5) * scale - 0.5;
          const rad = Math.ceil(scale);
          for (let yy = Math.floor(cy - rad); yy <= Math.ceil(cy + rad); yy++)
            for (let xx = Math.floor(cx - rad); xx <= Math.ceil(cx + rad); xx++) {
              if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
              const d2 = (xx - cx) ** 2 + (yy - cy) ** 2;
              const w = Math.exp(-d2 / (2 * (scale * 0.6) ** 2));
              corr[yy * W + xx]! += w * e;
              wsum[yy * W + xx]! += w;
            }
        }
    }
    const next = makeGray(W, H);
    for (let k = 0; k < W * H; k++) next.data[k] = Math.max(0, Math.min(1, hr.data[k]! + (wsum[k]! > 0 ? corr[k]! / wsum[k]! : 0)));
    hr = next;
  }
  return { hr, registrations, usedFrames: used, rejectedFrames: rejected, iterations };
}

/** Single-image restoration: bilinear interpolation + mild unsharp masking. Sharper-looking, no new information. */
export function singleFrameRestore(frame: Gray, scale = 4): Gray {
  return unsharp(resize(frame, frame.width * scale, frame.height * scale), scale * 0.8, 0.6);
}

export function originalUpscaled(frame: Gray, scale = 4): Gray {
  return upscaleNearest(frame, scale);
}
