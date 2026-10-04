import { makeGray, meanStd, type Gray } from './raster.ts';

/**
 * Raster change detection between two co-registered captures of the same ground grid.
 * Steps: radiometric normalisation (mean/std matching, compensates sun/exposure), absolute difference,
 * robust threshold (median + k·MAD), 3×3 morphological opening, 4-connected components, area filter.
 */
export interface ChangeRegion {
  id: number;
  pixels: number;
  /** Pixel bounding box [x0, y0, x1, y1] inclusive. */
  bbox: [number, number, number, number];
  centroid: { x: number; y: number };
  meanDiff: number;
}

export function normalizeTo(src: Gray, ref: Gray): Gray {
  const a = meanStd(src);
  const b = meanStd(ref);
  const out = makeGray(src.width, src.height);
  // Gain correction only when both images carry texture; otherwise match the offset only.
  const k = a.std > 1e-3 && b.std > 1e-3 ? b.std / a.std : 1;
  for (let i = 0; i < src.data.length; i++) out.data[i] = (src.data[i]! - a.mean) * k + b.mean;
  return out;
}

function median(values: Float32Array): number {
  const s = Float32Array.from(values).sort();
  return s[Math.floor(s.length / 2)] ?? 0;
}

export function detectChanges(a: Gray, b: Gray, opts: { k?: number; minPixels?: number; minAbs?: number } = {}): { regions: ChangeRegion[]; mask: Uint8Array; threshold: number } {
  if (a.width !== b.width || a.height !== b.height) throw new Error('detectChanges: size mismatch');
  const k = opts.k ?? 6;
  const minPixels = opts.minPixels ?? 6;
  const bn = normalizeTo(b, a);
  const diff = new Float32Array(a.data.length);
  for (let i = 0; i < diff.length; i++) diff[i] = Math.abs(bn.data[i]! - a.data[i]!);
  const med = median(diff);
  const mad = median(diff.map((d) => Math.abs(d - med))) * 1.4826;
  const threshold = Math.max(opts.minAbs ?? 0.08, med + k * mad);
  const W = a.width;
  const H = a.height;
  let mask = new Uint8Array(W * H);
  for (let i = 0; i < diff.length; i++) mask[i] = diff[i]! > threshold ? 1 : 0;
  // Opening = erosion then dilation (3×3).
  const morph = (src: Uint8Array, erode: boolean) => {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let v = erode ? 1 : 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            const s = xx < 0 || yy < 0 || xx >= W || yy >= H ? (erode ? 1 : 0) : src[yy * W + xx]!;
            if (erode) v &= s;
            else v |= s;
          }
        out[y * W + x] = v;
      }
    return out;
  };
  mask = morph(morph(mask, true), false);
  const labels = new Int32Array(W * H);
  const regions: ChangeRegion[] = [];
  let next = 1;
  const stack: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || labels[i]) continue;
    const id = next++;
    let pixels = 0;
    let sx = 0;
    let sy = 0;
    let sd = 0;
    let x0 = W;
    let y0 = H;
    let x1 = 0;
    let y1 = 0;
    stack.push(i);
    labels[i] = id;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p / W) | 0;
      pixels++;
      sx += x;
      sy += y;
      sd += diff[p]!;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const q of nb) if (q >= 0 && mask[q] && !labels[q]) {
        labels[q] = id;
        stack.push(q);
      }
    }
    if (pixels >= minPixels) regions.push({ id, pixels, bbox: [x0, y0, x1, y1], centroid: { x: sx / pixels, y: sy / pixels }, meanDiff: sd / pixels });
  }
  regions.sort((p, q) => q.pixels * q.meanDiff - p.pixels * p.meanDiff);
  return { regions, mask, threshold };
}
