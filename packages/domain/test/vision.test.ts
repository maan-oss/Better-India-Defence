import { describe, expect, it } from 'vitest';
import {
  type RgbImage,
  FACE_TEMPLATE_112,
  applyOp,
  decodeYolox,
  estimateNoiseSigma,
  gaussianPlane,
  imageStats,
  invertAffine,
  iou,
  letterboxBgr,
  luma,
  makeRgb,
  nms,
  resizeRgb,
  similarityTransform,
  worstState,
} from '../src/vision/index.ts';
import { mulberry32 } from '../src/random.ts';

/** Deterministic test image: 24 px checker, gradient and a disc (large flat regions with sharp edges). */
function scene(w: number, h: number): RgbImage {
  const img = makeRgb(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = ((Math.floor(x / 24) + Math.floor(y / 24)) % 2) * 0.5 + 0.2 + 0.2 * (x / w);
      const disc = (x - w / 3) ** 2 + (y - h / 2) ** 2 < (h / 5) ** 2 ? 0.25 : 0;
      img.data[(y * w + x) * 3] = Math.min(1, c + disc);
      img.data[(y * w + x) * 3 + 1] = c;
      img.data[(y * w + x) * 3 + 2] = Math.max(0, c - disc);
    }
  return img;
}

const psnr = (a: RgbImage, b: RgbImage) => {
  let s = 0;
  for (let i = 0; i < a.data.length; i++) s += (a.data[i]! - b.data[i]!) ** 2;
  return 10 * Math.log10(1 / (s / a.data.length));
};

describe('vision geometry', () => {
  it('similarity transform recovers rotation, scale and translation exactly', () => {
    const ang = 0.3;
    const s = 1.7;
    const fwd = (p: readonly [number, number]): [number, number] => [s * (Math.cos(ang) * p[0] - Math.sin(ang) * p[1]) + 12, s * (Math.sin(ang) * p[0] + Math.cos(ang) * p[1]) - 5];
    const src = FACE_TEMPLATE_112.map((p) => [p[0], p[1]] as [number, number]);
    const m = similarityTransform(src, src.map(fwd));
    for (const p of src) {
      const q = fwd(p);
      expect(m[0] * p[0] + m[1] * p[1] + m[2]).toBeCloseTo(q[0], 6);
      expect(m[3] * p[0] + m[4] * p[1] + m[5]).toBeCloseTo(q[1], 6);
    }
    const inv = invertAffine(m);
    const q = fwd(src[2]!);
    expect(inv[0] * q[0] + inv[1] * q[1] + inv[2]).toBeCloseTo(src[2]![0], 6);
  });

  it('letterbox keeps aspect ratio, anchors top-left, emits BGR 0–255 and pads', () => {
    const img = makeRgb(320, 160);
    for (let i = 0; i < img.width * img.height; i++) img.data[i * 3] = 1; // pure red
    const lb = letterboxBgr(img, 640, 114);
    expect(lb.ratio).toBe(2);
    const plane = 640 * 640;
    expect(lb.tensor[2 * plane + 10 * 640 + 10]).toBeCloseTo(255, 3); // R channel is last (BGR)
    expect(lb.tensor[10 * 640 + 10]).toBeCloseTo(0, 3);
    expect(lb.tensor[600 * 640 + 10]).toBe(114); // padding below the image
  });

  it('decodes a YOLOX anchor into source-image pixels and suppresses duplicates', () => {
    const out = new Float32Array(8400 * 85);
    // Anchor at stride-8 grid (10, 5): centre offset (0.5, 0.5), size e^2·8 ≈ 59 px; class 2 (car).
    const a = 5 * 80 + 10;
    out.set([0.5, 0.5, 2, 2, 0.9], a * 85);
    out[a * 85 + 5 + 2] = 0.8;
    out.set([0.6, 0.5, 2, 2, 0.85], (a + 1) * 85); // neighbour, same object
    out[(a + 1) * 85 + 5 + 2] = 0.8;
    const d = decodeYolox(out, 640, 0.5, 0.3);
    expect(d).toHaveLength(1);
    expect(d[0]!.label).toBe('car');
    expect(d[0]!.category).toBe('vehicle');
    expect(d[0]!.x + d[0]!.w / 2).toBeCloseTo((10.5 * 8) / 0.5, 3);
    expect(iou(d[0]!, { x: d[0]!.x, y: d[0]!.y, w: d[0]!.w, h: d[0]!.h })).toBeCloseTo(1, 9);
    expect(nms([{ x: 0, y: 0, w: 10, h: 10, score: 0.9 }, { x: 20, y: 20, w: 10, h: 10, score: 0.8 }], 0.5)).toHaveLength(2);
  });
});

describe('restoration operators (measured, not asserted)', () => {
  const ref = scene(160, 120);

  it('denoise reduces measured noise and raises PSNR against the clean reference', () => {
    const rnd = mulberry32(7);
    const noisy = makeRgb(ref.width, ref.height);
    for (let i = 0; i < ref.data.length; i++) noisy.data[i] = Math.min(1, Math.max(0, ref.data[i]! + (rnd() - 0.5) * 0.15));
    const out = applyOp(noisy, { op: 'denoise', strength: 0.8 });
    expect(estimateNoiseSigma(luma(out))).toBeLessThan(estimateNoiseSigma(luma(noisy)));
    expect(psnr(out, ref)).toBeGreaterThan(psnr(noisy, ref) + 2);
  });

  it('Richardson–Lucy deblur recovers a Gaussian-blurred image better than the blurred input', () => {
    const blurred = makeRgb(ref.width, ref.height);
    for (let c = 0; c < 3; c++) {
      const ch = { width: ref.width, height: ref.height, data: new Float32Array(ref.width * ref.height) };
      for (let i = 0; i < ch.data.length; i++) ch.data[i] = ref.data[i * 3 + c]!;
      const b = gaussianPlane(ch, 1.5);
      for (let i = 0; i < ch.data.length; i++) blurred.data[i * 3 + c] = b.data[i]!;
    }
    const out = applyOp(blurred, { op: 'deblur', psf: 'gaussian', sigma: 1.5, iterations: 25 });
    expect(psnr(out, ref)).toBeGreaterThan(psnr(blurred, ref) + 1);
  });

  it('dehaze restores contrast lost to a uniform veil', () => {
    const hazy = makeRgb(ref.width, ref.height);
    for (let i = 0; i < ref.data.length; i++) hazy.data[i] = ref.data[i]! * 0.4 + 0.55;
    const out = applyOp(hazy, { op: 'dehaze', strength: 0.95 });
    expect(imageStats(out).contrast).toBeGreaterThan(imageStats(hazy).contrast * 1.5);
  });

  it('low-light enhancement brightens without clipping and CLAHE stays in range', () => {
    const dark = makeRgb(ref.width, ref.height);
    for (let i = 0; i < ref.data.length; i++) dark.data[i] = ref.data[i]! * 0.08;
    const out = applyOp(dark, { op: 'low_light', strength: 0.9 });
    expect(imageStats(out).meanLuma).toBeGreaterThan(imageStats(dark).meanLuma * 3);
    expect(imageStats(out).clippedBright).toBeLessThan(0.05);
    const c = applyOp(ref, { op: 'clahe', clipLimit: 2, tiles: 4 });
    expect(Math.max(...c.data)).toBeLessThanOrEqual(1);
    expect(Math.min(...c.data)).toBeGreaterThanOrEqual(0);
  });

  it('bicubic upscale is interpolation: downscale(upscale(x)) ≈ x', () => {
    const up = resizeRgb(ref, ref.width * 2, ref.height * 2);
    const back = resizeRgb(up, ref.width, ref.height);
    expect(psnr(back, ref)).toBeGreaterThan(28);
  });

  it('provenance only ever gets more derived', () => {
    expect(worstState('ORIGINAL', 'RESTORED')).toBe('RESTORED');
    expect(worstState('AI-INFERRED', 'RESTORED')).toBe('AI-INFERRED');
    expect(worstState('MULTI-OBSERVATION', 'RESTORED')).toBe('MULTI-OBSERVATION');
  });
});
