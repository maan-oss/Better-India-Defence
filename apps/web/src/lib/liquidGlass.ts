/**
 * Lensing for the Liquid Glass surfaces. Apple's material bends the light behind a surface toward its edge, so
 * content near the rim looks pushed inward. CSS has no such filter, but Chromium applies an SVG displacement
 * filter to a backdrop, so the lens is generated as a displacement map and used there. Other engines keep the
 * blur, tint and lit edge that glass.css draws, which is the same material without the bend.
 */
const BEZEL = 0.24; // the share of each side that is curved
const SIZE = 256;

/** Channel value for one axis: 0.5 is no shift, and the curve starts at the edge and eases into the flat middle. */
function shift(u: number): number {
  const e = Math.min(u, 1 - u);
  if (e >= BEZEL) return 0.5;
  const t = 1 - e / BEZEL;
  const push = 0.5 * t * t;
  return u < 0.5 ? 0.5 - push : 0.5 + push;
}

export function enableLensing(): void {
  if (!/Chrome\//.test(navigator.userAgent)) return;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext('2d');
  const map = document.getElementById('liquid-lens-map');
  if (!g || !map) return;
  const img = g.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      img.data[i] = Math.round(shift((x + 0.5) / SIZE) * 255);
      img.data[i + 1] = Math.round(shift((y + 0.5) / SIZE) * 255);
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  map.setAttribute('href', canvas.toDataURL('image/png'));
  document.documentElement.classList.add('lens');
}
