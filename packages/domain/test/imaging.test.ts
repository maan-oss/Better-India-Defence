import { describe, expect, it } from 'vitest';
import {
  degrade,
  detectChanges,
  makeGray,
  mulberry32,
  gaussian,
  multiFrameReconstruct,
  originalUpscaled,
  psnr,
  registerTranslation,
  renderMarking,
  singleFrameRestore,
  type Gray,
} from '../src/index.ts';

const truth = (): Gray => {
  // Marking on a plate with margin so registration has vertical structure to work with.
  const m = renderMarking('KX-4471', 192, 36);
  const g = makeGray(224, 64, 0.12);
  for (let y = 0; y < 36; y++) for (let x = 0; x < 192; x++) g.data[(y + 14) * 224 + x + 16] = m.data[y * 192 + x]!;
  return g;
};

function addNoise(g: Gray, sigma: number, seed: number): Gray {
  const rng = mulberry32(seed);
  return { ...g, data: g.data.map((v) => Math.max(0, Math.min(1, v + sigma * gaussian(rng)))) };
}

describe('multi-frame reconstruction', () => {
  it('registers sub-pixel shifts', () => {
    const t = truth();
    const ref = degrade(t, 4, 0, 0, 1.8);
    const img = degrade(t, 4, 0.37, -0.22, 1.8);
    const r = registerTranslation(ref, img);
    // Bilinear-interpolation bias limits accuracy to ~0.05–0.1 LR pixels.
    expect(Math.abs(r.dx + 0.37)).toBeLessThan(0.1);
    expect(Math.abs(r.dy - 0.22)).toBeLessThan(0.1);
  });

  it('beats single-frame restoration when measured against the reference target', () => {
    const t = truth();
    const rng = mulberry32(42);
    const frames: Gray[] = [];
    for (let i = 0; i < 16; i++) {
      const dx = i === 0 ? 0 : rng() - 0.5;
      const dy = i === 0 ? 0 : rng() - 0.5;
      frames.push(addNoise(degrade(t, 4, dx, dy, 1.8), 0.03, 100 + i));
    }
    const mf = multiFrameReconstruct(frames, 4, 20);
    const crop = (g: Gray) => g; // same size by construction
    const pOrig = psnr(crop(originalUpscaled(frames[0]!, 4)), t);
    const pRest = psnr(crop(singleFrameRestore(frames[0]!, 4)), t);
    const pMulti = psnr(crop(mf.hr), t);
    expect(mf.usedFrames.length).toBeGreaterThanOrEqual(14);
    expect(pMulti).toBeGreaterThan(pRest + 1);
    expect(pMulti).toBeGreaterThan(pOrig + 1);
  });
});

describe('raster change detection', () => {
  it('finds an inserted object and ignores global brightness change', () => {
    const a = makeGray(64, 64, 0.4);
    const b = makeGray(64, 64, 0.55);
    for (let y = 20; y < 28; y++) for (let x = 30; x < 40; x++) b.data[y * 64 + x] = 0.95;
    const r = detectChanges(a, b);
    expect(r.regions.length).toBe(1);
    const reg = r.regions[0]!;
    expect(reg.centroid.x).toBeGreaterThan(30);
    expect(reg.centroid.x).toBeLessThan(40);
  });
});
