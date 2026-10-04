/** Single-channel floating-point raster (values nominally 0..1). */
export interface Gray {
  width: number;
  height: number;
  data: Float32Array;
}

export const makeGray = (width: number, height: number, fill = 0): Gray => ({ width, height, data: new Float32Array(width * height).fill(fill) });

export const grayAt = (g: Gray, x: number, y: number): number => {
  const xi = Math.min(g.width - 1, Math.max(0, x | 0));
  const yi = Math.min(g.height - 1, Math.max(0, y | 0));
  return g.data[yi * g.width + xi]!;
};

/** Bilinear sample with edge clamping. */
export function sampleBilinear(g: Gray, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = grayAt(g, x0, y0);
  const b = grayAt(g, x0 + 1, y0);
  const c = grayAt(g, x0, y0 + 1);
  const d = grayAt(g, x0 + 1, y0 + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** RGBA (8-bit) → luminance raster. */
export function rgbaToGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Gray {
  const g = makeGray(width, height);
  for (let i = 0; i < width * height; i++) {
    g.data[i] = (0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!) / 255;
  }
  return g;
}

export function grayToRgba(g: Gray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.width * g.height; i++) {
    const v = Math.round(Math.max(0, Math.min(1, g.data[i]!)) * 255);
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function crop(g: Gray, x0: number, y0: number, w: number, h: number): Gray {
  const out = makeGray(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.data[y * w + x] = grayAt(g, x0 + x, y0 + y);
  return out;
}

/** Separable Gaussian blur. */
export function gaussianBlur(g: Gray, sigma: number): Gray {
  if (sigma <= 0) return { ...g, data: g.data.slice() };
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k: number[] = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  const tmp = makeGray(g.width, g.height);
  const out = makeGray(g.width, g.height);
  for (let y = 0; y < g.height; y++)
    for (let x = 0; x < g.width; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r]! * grayAt(g, x + i, y);
      tmp.data[y * g.width + x] = s;
    }
  for (let y = 0; y < g.height; y++)
    for (let x = 0; x < g.width; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r]! * grayAt(tmp, x, y + i);
      out.data[y * g.width + x] = s;
    }
  return out;
}

/** Resample to a new size with bilinear interpolation (pixel-centre aligned). */
export function resize(g: Gray, w: number, h: number): Gray {
  const out = makeGray(w, h);
  const sx = g.width / w;
  const sy = g.height / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out.data[y * w + x] = sampleBilinear(g, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
  return out;
}

/** Nearest-neighbour upscale — shows the original pixels without inventing detail. */
export function upscaleNearest(g: Gray, s: number): Gray {
  const out = makeGray(g.width * s, g.height * s);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) out.data[y * out.width + x] = g.data[Math.floor(y / s) * g.width + Math.floor(x / s)]!;
  return out;
}

export function unsharp(g: Gray, sigma: number, amount: number): Gray {
  const b = gaussianBlur(g, sigma);
  const out = makeGray(g.width, g.height);
  for (let i = 0; i < g.data.length; i++) out.data[i] = Math.max(0, Math.min(1, g.data[i]! + amount * (g.data[i]! - b.data[i]!)));
  return out;
}

export function psnr(a: Gray, b: Gray): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('psnr: size mismatch');
  let mse = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = a.data[i]! - b.data[i]!;
    mse += d * d;
  }
  mse /= a.data.length;
  return mse <= 1e-12 ? 99 : 10 * Math.log10(1 / mse);
}

/** Mean SSIM over 8×8 windows (stride 4). */
export function ssim(a: Gray, b: Gray): number {
  const C1 = 0.01 ** 2;
  const C2 = 0.03 ** 2;
  let total = 0;
  let n = 0;
  for (let y0 = 0; y0 + 8 <= a.height; y0 += 4)
    for (let x0 = 0; x0 + 8 <= a.width; x0 += 4) {
      let ma = 0;
      let mb = 0;
      for (let y = y0; y < y0 + 8; y++)
        for (let x = x0; x < x0 + 8; x++) {
          ma += a.data[y * a.width + x]!;
          mb += b.data[y * b.width + x]!;
        }
      ma /= 64;
      mb /= 64;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let y = y0; y < y0 + 8; y++)
        for (let x = x0; x < x0 + 8; x++) {
          const da = a.data[y * a.width + x]! - ma;
          const db = b.data[y * b.width + x]! - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      va /= 63;
      vb /= 63;
      cov /= 63;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  return n ? total / n : 0;
}

export function meanStd(g: Gray): { mean: number; std: number } {
  let s = 0;
  for (const v of g.data) s += v;
  const mean = s / g.data.length;
  let v2 = 0;
  for (const v of g.data) v2 += (v - mean) ** 2;
  return { mean, std: Math.sqrt(v2 / g.data.length) };
}
