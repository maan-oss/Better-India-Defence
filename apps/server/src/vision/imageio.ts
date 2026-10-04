import { spawnSync } from 'node:child_process';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { type RgbImage, fromRgba, makeRgb, toRgba } from '@strata/domain/vision';

/** Hard limits so a hostile or corrupt upload cannot exhaust memory. */
export const MAX_PIXELS = 40_000_000;

export type ImageFormat = 'jpeg' | 'png' | 'other';

export function sniff(bytes: Uint8Array): ImageFormat {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return 'other';
}

export class ImageDecodeError extends Error {}

/** Decode JPEG/PNG natively; anything else (WebP, BMP, TIFF, HEIC if ffmpeg supports it) via ffmpeg. */
export function decodeImage(bytes: Uint8Array): RgbImage {
  const fmt = sniff(bytes);
  try {
    if (fmt === 'jpeg') {
      const d = jpeg.decode(Buffer.from(bytes), { useTArray: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 1024 });
      return applyOrientation(fromRgba(d.data, d.width, d.height), exifOrientation(bytes));
    }
    if (fmt === 'png') {
      const p = PNG.sync.read(Buffer.from(bytes));
      if (p.width * p.height > MAX_PIXELS) throw new ImageDecodeError('image too large');
      return fromRgba(p.data, p.width, p.height);
    }
  } catch (e) {
    if (e instanceof ImageDecodeError) throw e;
    throw new ImageDecodeError(`could not decode ${fmt}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { input: Buffer.from(bytes), maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout?.length) throw new ImageDecodeError(`unsupported image format${r.stderr ? `: ${r.stderr.toString().slice(0, 200)}` : ''}`);
  const p = PNG.sync.read(r.stdout);
  if (p.width * p.height > MAX_PIXELS) throw new ImageDecodeError('image too large');
  return fromRgba(p.data, p.width, p.height);
}

export function encodeJpeg(img: RgbImage, quality = 92): Uint8Array {
  const enc = jpeg.encode({ data: toRgba(img), width: img.width, height: img.height }, quality);
  return new Uint8Array(enc.data);
}

/** Lossless output for evidential products. */
export function encodePng(img: RgbImage): Uint8Array {
  const p = new PNG({ width: img.width, height: img.height });
  p.data = Buffer.from(toRgba(img));
  return new Uint8Array(PNG.sync.write(p));
}

/** EXIF orientation tag (1–8) from a JPEG APP1 segment; 1 when absent. */
export function exifOrientation(b: Uint8Array): number {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10;
      const le = b[t] === 0x49;
      const u16 = (o: number) => (le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!);
      const u32 = (o: number) => (le ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0 : ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0);
      const ifd = t + u32(t + 4);
      if (ifd + 2 > b.length) return 1;
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 10 > b.length) break;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
      return 1;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return 1;
}

export function applyOrientation(img: RgbImage, o: number): RgbImage {
  if (o <= 1 || o > 8) return img;
  const swap = o >= 5;
  const W = swap ? img.height : img.width;
  const H = swap ? img.width : img.height;
  const out = makeRgb(W, H);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      let nx: number;
      let ny: number;
      switch (o) {
        case 2: nx = img.width - 1 - x; ny = y; break;
        case 3: nx = img.width - 1 - x; ny = img.height - 1 - y; break;
        case 4: nx = x; ny = img.height - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = img.height - 1 - y; ny = x; break;
        case 7: nx = img.height - 1 - y; ny = img.width - 1 - x; break;
        default: nx = y; ny = img.width - 1 - x; break;
      }
      const si = (y * img.width + x) * 3;
      const di = (ny * W + nx) * 3;
      out.data[di] = img.data[si]!;
      out.data[di + 1] = img.data[si + 1]!;
      out.data[di + 2] = img.data[si + 2]!;
    }
  return out;
}
