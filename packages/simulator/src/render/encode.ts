import jpeg from 'jpeg-js';

export function encodeJpeg(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, quality = 82): Uint8Array {
  const out = jpeg.encode({ data: rgba, width, height }, quality);
  return new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength);
}
