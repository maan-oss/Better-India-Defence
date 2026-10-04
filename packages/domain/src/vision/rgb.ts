/**
 * Colour raster primitives for the vision engine. Images are linear arrays of interleaved RGB float samples
 * in [0, 1] (sRGB-encoded values; no colour management is applied). Everything here is deterministic and
 * allocation-explicit so it can run inside worker threads on large frames.
 */
export interface RgbImage {
  width: number;
  height: number;
  /** Interleaved R, G, B; length = width × height × 3. */
  data: Float32Array;
}

/** Single-channel float plane. */
export interface Plane {
  width: number;
  height: number;
  data: Float32Array;
}

export const makeRgb = (width: number, height: number): RgbImage => ({ width, height, data: new Float32Array(width * height * 3) });
export const makePlane = (width: number, height: number, fill = 0): Plane => ({ width, height, data: new Float32Array(width * height).fill(fill) });
export const cloneRgb = (img: RgbImage): RgbImage => ({ width: img.width, height: img.height, data: new Float32Array(img.data) });

export function fromRgba(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): RgbImage {
  const out = makeRgb(width, height);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    out.data[i * 3] = rgba[i * 4]! / 255;
    out.data[i * 3 + 1] = rgba[i * 4 + 1]! / 255;
    out.data[i * 3 + 2] = rgba[i * 4 + 2]! / 255;
  }
  return out;
}

export function fromRgb24(rgb: Uint8Array, width: number, height: number): RgbImage {
  const out = makeRgb(width, height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = rgb[i]! / 255;
  return out;
}

export function toRgba(img: RgbImage): Uint8ClampedArray {
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.round(img.data[i * 3]! * 255);
    out[i * 4 + 1] = Math.round(img.data[i * 3 + 1]! * 255);
    out[i * 4 + 2] = Math.round(img.data[i * 3 + 2]! * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function clampImage(img: RgbImage): RgbImage {
  for (let i = 0; i < img.data.length; i++) img.data[i] = clamp01(img.data[i]!);
  return img;
}

// ---------------------------------------------------------------------------------------------------------
// Colour space (BT.601 full-range YCbCr). Luma-only processing avoids colour fringing and is how most
// restoration operators are applied in practice.

export function splitYCbCr(img: RgbImage): { y: Plane; cb: Plane; cr: Plane } {
  const { width, height, data } = img;
  const y = makePlane(width, height);
  const cb = makePlane(width, height);
  const cr = makePlane(width, height);
  for (let i = 0, n = width * height; i < n; i++) {
    const r = data[i * 3]!;
    const g = data[i * 3 + 1]!;
    const b = data[i * 3 + 2]!;
    y.data[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb.data[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    cr.data[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return { y, cb, cr };
}

export function mergeYCbCr(y: Plane, cb: Plane, cr: Plane): RgbImage {
  const out = makeRgb(y.width, y.height);
  for (let i = 0, n = y.width * y.height; i < n; i++) {
    const Y = y.data[i]!;
    const B = cb.data[i]!;
    const R = cr.data[i]!;
    out.data[i * 3] = clamp01(Y + 1.402 * R);
    out.data[i * 3 + 1] = clamp01(Y - 0.344136 * B - 0.714136 * R);
    out.data[i * 3 + 2] = clamp01(Y + 1.772 * B);
  }
  return out;
}

export function luma(img: RgbImage): Plane {
  const p = makePlane(img.width, img.height);
  for (let i = 0, n = img.width * img.height; i < n; i++) p.data[i] = 0.299 * img.data[i * 3]! + 0.587 * img.data[i * 3 + 1]! + 0.114 * img.data[i * 3 + 2]!;
  return p;
}

export function channel(img: RgbImage, c: 0 | 1 | 2): Plane {
  const p = makePlane(img.width, img.height);
  for (let i = 0, n = img.width * img.height; i < n; i++) p.data[i] = img.data[i * 3 + c]!;
  return p;
}

export function fromPlanes(r: Plane, g: Plane, b: Plane): RgbImage {
  const out = makeRgb(r.width, r.height);
  for (let i = 0, n = r.width * r.height; i < n; i++) {
    out.data[i * 3] = clamp01(r.data[i]!);
    out.data[i * 3 + 1] = clamp01(g.data[i]!);
    out.data[i * 3 + 2] = clamp01(b.data[i]!);
  }
  return out;
}

export function grayToRgb(p: Plane): RgbImage {
  return fromPlanes(p, p, p);
}

// ---------------------------------------------------------------------------------------------------------
// Geometry

export function cropRgb(img: RgbImage, x0: number, y0: number, w: number, h: number): RgbImage {
  const out = makeRgb(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.max(0, y0 + y));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, x0 + x));
      const si = (sy * img.width + sx) * 3;
      const di = (y * w + x) * 3;
      out.data[di] = img.data[si]!;
      out.data[di + 1] = img.data[si + 1]!;
      out.data[di + 2] = img.data[si + 2]!;
    }
  }
  return out;
}

/** Bilinear sample of one channel with edge clamping. */
export function sampleRgb(img: RgbImage, x: number, y: number, c: number): number {
  const w = img.width;
  const h = img.height;
  const xf = Math.min(w - 1, Math.max(0, x));
  const yf = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(xf);
  const y0 = Math.floor(yf);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = xf - x0;
  const fy = yf - y0;
  const d = img.data;
  const a = d[(y0 * w + x0) * 3 + c]!;
  const b = d[(y0 * w + x1) * 3 + c]!;
  const e = d[(y1 * w + x0) * 3 + c]!;
  const f = d[(y1 * w + x1) * 3 + c]!;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (e * (1 - fx) + f * fx) * fy;
}

/**
 * Resize. Downscaling averages over the source footprint (area filter, no aliasing); upscaling uses Keys
 * bicubic (a = −0.5). Neither adds information.
 */
export function resizeRgb(img: RgbImage, w: number, h: number): RgbImage {
  if (w === img.width && h === img.height) return cloneRgb(img);
  const sx = img.width / w;
  const sy = img.height / h;
  if (sx >= 1 && sy >= 1) return resizeArea(img, w, h);
  // Separable Keys bicubic: horizontal pass into a w × img.height buffer, then vertical.
  const kx = cubicWeights(w, img.width);
  const ky = cubicWeights(h, img.height);
  const H0 = img.height;
  const tmp = new Float32Array(w * H0 * 3);
  const src = img.data;
  for (let y = 0; y < H0; y++) {
    const row = y * img.width;
    for (let x = 0; x < w; x++) {
      const i0 = kx.idx[x * 4]!, i1 = kx.idx[x * 4 + 1]!, i2 = kx.idx[x * 4 + 2]!, i3 = kx.idx[x * 4 + 3]!;
      const w0 = kx.w[x * 4]!, w1 = kx.w[x * 4 + 1]!, w2 = kx.w[x * 4 + 2]!, w3 = kx.w[x * 4 + 3]!;
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++)
        tmp[o + c] = src[(row + i0) * 3 + c]! * w0 + src[(row + i1) * 3 + c]! * w1 + src[(row + i2) * 3 + c]! * w2 + src[(row + i3) * 3 + c]! * w3;
    }
  }
  const out = makeRgb(w, h);
  for (let y = 0; y < h; y++) {
    const j0 = ky.idx[y * 4]! * w, j1 = ky.idx[y * 4 + 1]! * w, j2 = ky.idx[y * 4 + 2]! * w, j3 = ky.idx[y * 4 + 3]! * w;
    const w0 = ky.w[y * 4]!, w1 = ky.w[y * 4 + 1]!, w2 = ky.w[y * 4 + 2]!, w3 = ky.w[y * 4 + 3]!;
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        const v = tmp[(j0 + x) * 3 + c]! * w0 + tmp[(j1 + x) * 3 + c]! * w1 + tmp[(j2 + x) * 3 + c]! * w2 + tmp[(j3 + x) * 3 + c]! * w3;
        out.data[(y * w + x) * 3 + c] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
  }
  return out;
}

/** 4-tap weights per output sample (flattened: idx/w[o·4 + k]). Down-scaling never reaches here. */
function cubicWeights(outN: number, inN: number): { idx: Int32Array; w: Float32Array } {
  const s = inN / outN;
  const idx = new Int32Array(outN * 4);
  const w = new Float32Array(outN * 4);
  for (let o = 0; o < outN; o++) {
    const src = (o + 0.5) * s - 0.5;
    const i0 = Math.floor(src);
    for (let k = -1; k <= 2; k++) {
      idx[o * 4 + k + 1] = Math.min(inN - 1, Math.max(0, i0 + k));
      w[o * 4 + k + 1] = keys(Math.abs(src - (i0 + k)));
    }
  }
  return { idx, w };
}

function keys(t: number): number {
  const a = -0.5;
  if (t <= 1) return (a + 2) * t ** 3 - (a + 3) * t ** 2 + 1;
  if (t < 2) return a * t ** 3 - 5 * a * t ** 2 + 8 * a * t - 4 * a;
  return 0;
}

function resizeArea(img: RgbImage, w: number, h: number): RgbImage {
  const out = makeRgb(w, h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const ya = y * sy;
    const yb = (y + 1) * sy;
    for (let x = 0; x < w; x++) {
      const xa = x * sx;
      const xb = (x + 1) * sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      for (let yy = Math.floor(ya); yy < Math.min(img.height, Math.ceil(yb)); yy++) {
        const wy = Math.min(yb, yy + 1) - Math.max(ya, yy);
        for (let xx = Math.floor(xa); xx < Math.min(img.width, Math.ceil(xb)); xx++) {
          const wx = Math.min(xb, xx + 1) - Math.max(xa, xx);
          const wt = wx * wy;
          const i = (yy * img.width + xx) * 3;
          r += img.data[i]! * wt;
          g += img.data[i + 1]! * wt;
          b += img.data[i + 2]! * wt;
          wsum += wt;
        }
      }
      const o = (y * w + x) * 3;
      out.data[o] = r / wsum;
      out.data[o + 1] = g / wsum;
      out.data[o + 2] = b / wsum;
    }
  }
  return out;
}

export function resizePlane(p: Plane, w: number, h: number): Plane {
  return channel(resizeRgb(fromPlanes(p, p, p), w, h), 0);
}

/**
 * Inverse-mapped affine warp: out(x, y) = src(M · [x, y, 1]) where M maps OUTPUT to SOURCE coordinates
 * ([a, b, c, d, e, f] → sx = a·x + b·y + c, sy = d·x + e·y + f). Bilinear, edge-clamped.
 */
export function warpAffine(img: RgbImage, m: readonly [number, number, number, number, number, number], w: number, h: number): RgbImage {
  const out = makeRgb(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = m[0] * x + m[1] * y + m[2];
      const sy = m[3] * x + m[4] * y + m[5];
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) out.data[o + c] = sampleRgb(img, sx, sy, c);
    }
  return out;
}

/**
 * Least-squares similarity transform (rotation, uniform scale, translation) mapping `src` points onto `dst`
 * (Umeyama 1991, 2-D closed form). Returns forward [a, −b, tx, b, a, ty].
 */
export function similarityTransform(src: readonly (readonly [number, number])[], dst: readonly (readonly [number, number])[]): [number, number, number, number, number, number] {
  const n = src.length;
  let mxs = 0;
  let mys = 0;
  let mxd = 0;
  let myd = 0;
  for (let i = 0; i < n; i++) {
    mxs += src[i]![0];
    mys += src[i]![1];
    mxd += dst[i]![0];
    myd += dst[i]![1];
  }
  mxs /= n;
  mys /= n;
  mxd /= n;
  myd /= n;
  let sxx = 0;
  let sxy = 0;
  let varS = 0;
  for (let i = 0; i < n; i++) {
    const xs = src[i]![0] - mxs;
    const ys = src[i]![1] - mys;
    const xd = dst[i]![0] - mxd;
    const yd = dst[i]![1] - myd;
    sxx += xs * xd + ys * yd;
    sxy += xs * yd - ys * xd;
    varS += xs * xs + ys * ys;
  }
  const a = sxx / varS;
  const b = sxy / varS;
  return [a, -b, mxd - (a * mxs - b * mys), b, a, myd - (b * mxs + a * mys)];
}

/** Inverse of a forward similarity/affine [a, b, c, d, e, f]. */
export function invertAffine(m: readonly [number, number, number, number, number, number]): [number, number, number, number, number, number] {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d;
  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)];
}

// ---------------------------------------------------------------------------------------------------------
// Filters on planes

/** Mean over a (2r+1)² window via cumulative sums; O(N) regardless of r. Edges use the valid window. */
export function boxMean(p: Plane, r: number): Plane {
  const { width: w, height: h, data } = p;
  const tmp = new Float64Array(w * h);
  const out = makePlane(w, h);
  // horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const cs = new Float64Array(w + 1);
    for (let x = 0; x < w; x++) cs[x + 1] = cs[x]! + data[row + x]!;
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r);
      const b = Math.min(w - 1, x + r);
      tmp[row + x] = (cs[b + 1]! - cs[a]!) / (b - a + 1);
    }
  }
  // vertical pass
  const cs = new Float64Array(h + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) cs[y + 1] = cs[y]! + tmp[y * w + x]!;
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r);
      const b = Math.min(h - 1, y + r);
      out.data[y * w + x] = (cs[b + 1]! - cs[a]!) / (b - a + 1);
    }
  }
  return out;
}

/** Separable Gaussian blur (kernel truncated at 3σ, edges clamped). */
export function gaussianPlane(p: Plane, sigma: number): Plane {
  if (sigma <= 0) return { width: p.width, height: p.height, data: new Float32Array(p.data) };
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] = k[i]! / s;
  return convolveSeparable(p, k, k);
}

export function convolveSeparable(p: Plane, kx: Float32Array, ky: Float32Array): Plane {
  const { width: w, height: h } = p;
  const rx = (kx.length - 1) / 2;
  const ry = (ky.length - 1) / 2;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -rx; i <= rx; i++) acc += p.data[y * w + Math.min(w - 1, Math.max(0, x + i))]! * kx[i + rx]!;
      tmp[y * w + x] = acc;
    }
  const out = makePlane(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let j = -ry; j <= ry; j++) acc += tmp[Math.min(h - 1, Math.max(0, y + j)) * w + x]! * ky[j + ry]!;
      out.data[y * w + x] = acc;
    }
  return out;
}

/** Grey-level erosion over a (2r+1)² square (separable van Herk-style min, O(N·r) simple version). */
export function minFilter(p: Plane, r: number): Plane {
  const { width: w, height: h } = p;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) m = Math.min(m, p.data[y * w + i]!);
      tmp[y * w + x] = m;
    }
  const out = makePlane(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) m = Math.min(m, tmp[j * w + x]!);
      out.data[y * w + x] = m;
    }
  return out;
}

/**
 * Guided filter (He, Sun & Tang, TPAMI 2013): edge-preserving smoothing of `p` steered by guide `I`.
 * Radius r in pixels, regularisation eps (in squared intensity units).
 */
export function guidedFilter(I: Plane, p: Plane, r: number, eps: number): Plane {
  const n = I.width * I.height;
  const Ip = makePlane(I.width, I.height);
  const II = makePlane(I.width, I.height);
  for (let i = 0; i < n; i++) {
    Ip.data[i] = I.data[i]! * p.data[i]!;
    II.data[i] = I.data[i]! * I.data[i]!;
  }
  const mI = boxMean(I, r);
  const mp = boxMean(p, r);
  const mIp = boxMean(Ip, r);
  const mII = boxMean(II, r);
  const a = makePlane(I.width, I.height);
  const b = makePlane(I.width, I.height);
  for (let i = 0; i < n; i++) {
    const cov = mIp.data[i]! - mI.data[i]! * mp.data[i]!;
    const v = mII.data[i]! - mI.data[i]! * mI.data[i]!;
    a.data[i] = cov / (v + eps);
    b.data[i] = mp.data[i]! - a.data[i]! * mI.data[i]!;
  }
  const ma = boxMean(a, r);
  const mb = boxMean(b, r);
  const out = makePlane(I.width, I.height);
  for (let i = 0; i < n; i++) out.data[i] = ma.data[i]! * I.data[i]! + mb.data[i]!;
  return out;
}

/**
 * Noise standard deviation estimate (Immerkær 1996 operator, which cancels image structure to first
 * order). The operator's response to white Gaussian noise has σ_N = 6σ; we take a robust (median-based)
 * scale of the response so edges and texture — sparse large responses — do not inflate the estimate.
 */
export function estimateNoiseSigma(p: Plane): number {
  const { width: w, height: h, data } = p;
  if (w < 3 || h < 3) return 0;
  const step = Math.max(1, Math.floor(Math.sqrt(((w - 2) * (h - 2)) / 250_000)));
  const vals: number[] = [];
  for (let y = 1; y < h - 1; y += step)
    for (let x = 1; x < w - 1; x += step) {
      const i = y * w + x;
      vals.push(Math.abs(data[i - w - 1]! - 2 * data[i - w]! + data[i - w + 1]! - 2 * data[i - 1]! + 4 * data[i]! - 2 * data[i + 1]! + data[i + w - 1]! - 2 * data[i + w]! + data[i + w + 1]!));
    }
  vals.sort((a, b) => a - b);
  const med = vals[Math.floor(vals.length / 2)] ?? 0;
  return (1.4826 * med) / 6;
}

/** Variance of the Laplacian: a standard focus/sharpness measure (higher = sharper). */
export function laplacianVariance(p: Plane): number {
  const { width: w, height: h, data } = p;
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = data[i - w]! + data[i + w]! + data[i - 1]! + data[i + 1]! - 4 * data[i]!;
      s += v;
      s2 += v * v;
      n++;
    }
  if (!n) return 0;
  const m = s / n;
  return s2 / n - m * m;
}
