/**
 * 5×7 bitmap font for burned-in camera timestamps and for rendering reference markings.
 * Each glyph is 7 rows of 5 bits (MSB = leftmost column).
 */
const G: Record<string, number[]> = {
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  ':': [0, 12, 12, 0, 12, 12, 0],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 12, 12],
  '/': [1, 1, 2, 4, 8, 16, 16],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '|': [4, 4, 4, 4, 4, 4, 4],
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;

/** Returns 1 if the pixel (gx, gy) of the glyph for `ch` is set. */
export function glyphBit(ch: string, gx: number, gy: number): number {
  const rows = G[ch.toUpperCase()] ?? G[' ']!;
  if (gx < 0 || gx >= GLYPH_W || gy < 0 || gy >= GLYPH_H) return 0;
  return (rows[gy]! >> (GLYPH_W - 1 - gx)) & 1;
}

/** Sample a text string laid out on a unit rectangle (u,v ∈ [0,1]) with 1-glyph-cell spacing. Returns 0/1. */
export function textCoverage(text: string, u: number, v: number): number {
  const cells = text.length * (GLYPH_W + 1) + 1;
  const rowsTotal = GLYPH_H + 2;
  const cx = u * cells;
  const cy = v * rowsTotal;
  const col = Math.floor(cx);
  const row = Math.floor(cy) - 1;
  const ci = Math.floor((col - 1) / (GLYPH_W + 1));
  const gx = (col - 1) % (GLYPH_W + 1);
  if (ci < 0 || ci >= text.length || gx >= GLYPH_W) return 0;
  return glyphBit(text[ci]!, gx, row);
}

/** Aspect ratio (width/height) of a text marking rendered by textCoverage. */
export const textAspect = (text: string): number => (text.length * (GLYPH_W + 1) + 1) / (GLYPH_H + 2);

/** Draw text into an RGBA buffer (integer scale). */
export function drawText(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: [number, number, number],
  shadow = true,
): void {
  const put = (px: number, py: number, c: [number, number, number]) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const i = (py * width + px) * 4;
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
  };
  for (let i = 0; i < text.length; i++) {
    for (let gy = 0; gy < GLYPH_H; gy++)
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (!glyphBit(text[i]!, gx, gy)) continue;
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) {
            const px = x + (i * (GLYPH_W + 1) + gx) * scale + sx;
            const py = y + gy * scale + sy;
            if (shadow) put(px + 1, py + 1, [0, 0, 0]);
            put(px, py, color);
          }
      }
  }
}

/** Render a text marking as a truth raster (white text on dark plate). */
export function renderMarking(text: string, width: number, height: number): { width: number; height: number; data: Float32Array } {
  const data = new Float32Array(width * height);
  const ss = 4;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) acc += textCoverage(text, (x + (sx + 0.5) / ss) / width, (y + (sy + 0.5) / ss) / height);
      data[y * width + x] = 0.12 + 0.78 * (acc / (ss * ss));
    }
  return { width, height, data };
}
