import * as THREE from 'three';
import type { RenderTrack } from '../state/tracks';

/**
 * Tactical symbology after APP-6 / MIL-STD-2525: the frame shape carries the affiliation (friend rectangle,
 * hostile diamond, unknown quatrefoil, neutral square; air tracks use the open-bottom half frames), the icon
 * the function, and a dashed frame marks a track whose present position is not observed (coasting / lost —
 * the platform's INFERRED state). Colour reinforces the shape; it is never the only cue.
 */
export type Affiliation = 'friend' | 'hostile' | 'suspect' | 'neutral' | 'unknown';
export type Dimension = 'ground' | 'air';
export type Fn = 'infantry' | 'vehicle' | 'uav' | 'aircraft' | 'bird' | 'unknown';

export const AFF_COLOR: Record<Affiliation, string> = {
  friend: '#5aa9e6',
  hostile: '#ff4d3d',
  suspect: '#f08a24',
  neutral: '#5cc26f',
  unknown: '#f2d14b',
};

export interface SymbolSpec {
  aff: Affiliation;
  dim: Dimension;
  fn: Fn;
  dashed: boolean;
  selected: boolean;
}

export function symbolFor(tr: RenderTrack, selected: boolean): SymbolSpec {
  const rep = tr.reported?.affiliation;
  const aff: Affiliation = tr.cooperative || rep === 'friend' ? 'friend' : rep === 'hostile' ? 'hostile' : rep === 'suspect' ? 'suspect' : rep === 'neutral' || tr.classification === 'bird' ? 'neutral' : 'unknown';
  const dim: Dimension = tr.category === 'aerial' ? 'air' : 'ground';
  const fn: Fn =
    tr.category === 'aerial'
      ? tr.classification === 'drone' || (tr.cooperative && tr.category === 'aerial')
        ? 'uav'
        : tr.classification === 'aircraft'
          ? 'aircraft'
          : tr.classification === 'bird'
            ? 'bird'
            : 'unknown'
      : tr.category === 'person'
        ? 'infantry'
        : tr.category === 'vehicle'
          ? 'vehicle'
          : 'unknown';
  return { aff, dim, fn, dashed: tr.inferred, selected };
}

const SIZE = 128;
const cache = new Map<string, THREE.CanvasTexture>();

export function symbolTexture(s: SymbolSpec): THREE.CanvasTexture {
  const key = `${s.aff}|${s.dim}|${s.fn}|${s.dashed ? 1 : 0}|${s.selected ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  const g = cv.getContext('2d')!;
  draw(g, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** Frame path in a 128 px box centred at 64,64; returns the inner icon box. */
function frame(g: CanvasRenderingContext2D, aff: Affiliation, dim: Dimension): { x: number; y: number; w: number; h: number } {
  const c = 64;
  g.beginPath();
  if (aff === 'friend') {
    if (dim === 'air') {
      // Open-bottom arch.
      g.moveTo(c - 38, c + 22);
      g.lineTo(c - 38, c - 2);
      g.bezierCurveTo(c - 38, c - 44, c + 38, c - 44, c + 38, c - 2);
      g.lineTo(c + 38, c + 22);
      return { x: c - 26, y: c - 22, w: 52, h: 38 };
    }
    g.rect(c - 42, c - 28, 84, 56);
    return { x: c - 42, y: c - 28, w: 84, h: 56 };
  }
  if (aff === 'hostile' || aff === 'suspect') {
    if (dim === 'air') {
      g.moveTo(c - 40, c + 22);
      g.lineTo(c - 40, c + 2);
      g.lineTo(c, c - 40);
      g.lineTo(c + 40, c + 2);
      g.lineTo(c + 40, c + 22);
      return { x: c - 24, y: c - 18, w: 48, h: 36 };
    }
    g.moveTo(c, c - 46);
    g.lineTo(c + 46, c);
    g.lineTo(c, c + 46);
    g.lineTo(c - 46, c);
    g.closePath();
    return { x: c - 23, y: c - 23, w: 46, h: 46 };
  }
  if (aff === 'neutral') {
    if (dim === 'air') {
      g.moveTo(c - 36, c + 22);
      g.lineTo(c - 36, c - 36);
      g.lineTo(c + 36, c - 36);
      g.lineTo(c + 36, c + 22);
      return { x: c - 28, y: c - 28, w: 56, h: 44 };
    }
    g.rect(c - 36, c - 36, 72, 72);
    return { x: c - 36, y: c - 36, w: 72, h: 72 };
  }
  // Unknown: quatrefoil (four lobes).
  const r = 19;
  if (dim === 'air') {
    g.moveTo(c - 38, c + 22);
    g.lineTo(c - 38, c);
    g.arc(c - 19, c - 4, r, Math.PI, Math.PI * 1.55);
    g.arc(c, c - 22, r, Math.PI * 1.15, Math.PI * 1.85);
    g.arc(c + 19, c - 4, r, Math.PI * 1.45, 0);
    g.lineTo(c + 38, c + 22);
    return { x: c - 24, y: c - 22, w: 48, h: 38 };
  }
  g.arc(c, c - 22, r, Math.PI * 0.85, Math.PI * 2.15);
  g.arc(c + 22, c, r, Math.PI * 1.35, Math.PI * 0.65);
  g.arc(c, c + 22, r, Math.PI * 1.85, Math.PI * 1.15);
  g.arc(c - 22, c, r, Math.PI * 0.35, Math.PI * 1.65);
  g.closePath();
  return { x: c - 26, y: c - 26, w: 52, h: 52 };
}

function draw(g: CanvasRenderingContext2D, s: SymbolSpec): void {
  const col = AFF_COLOR[s.aff];
  g.lineJoin = 'round';
  g.lineCap = 'round';
  if (s.selected) {
    g.save();
    g.shadowColor = '#e8c97f';
    g.shadowBlur = 18;
    g.strokeStyle = 'rgba(232, 201, 127, 0.95)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(64, 64, 58, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }
  // Dark under-stroke so the symbol reads on any background.
  frame(g, s.aff, s.dim);
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.lineWidth = 9;
  g.setLineDash([]);
  g.stroke();
  const box = frame(g, s.aff, s.dim);
  g.fillStyle = `${col}${s.dashed ? '22' : '47'}`;
  g.fill();
  g.strokeStyle = col;
  g.lineWidth = 5;
  g.setLineDash(s.dashed ? [11, 8] : []);
  g.stroke();
  g.setLineDash([]);
  // Function icon.
  g.strokeStyle = '#f4f6f8';
  g.fillStyle = '#f4f6f8';
  g.lineWidth = 4;
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (s.fn) {
    case 'infantry':
      g.beginPath();
      if (s.aff === 'friend' && s.dim === 'ground') {
        g.moveTo(x, y);
        g.lineTo(x + w, y + h);
        g.moveTo(x + w, y);
        g.lineTo(x, y + h);
      } else {
        const k = Math.min(w, h) * 0.36;
        g.moveTo(cx - k, cy - k);
        g.lineTo(cx + k, cy + k);
        g.moveTo(cx + k, cy - k);
        g.lineTo(cx - k, cy + k);
      }
      g.stroke();
      break;
    case 'vehicle': {
      g.beginPath();
      g.ellipse(cx, cy - 2, Math.min(w * 0.36, 24), Math.min(h * 0.22, 11), 0, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(cx - 10, cy + 14, 4, 0, Math.PI * 2);
      g.arc(cx + 10, cy + 14, 4, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'uav':
      g.beginPath();
      g.moveTo(cx - 22, cy - 8);
      g.lineTo(cx, cy + 6);
      g.lineTo(cx + 22, cy - 8);
      g.lineTo(cx, cy + 16);
      g.closePath();
      g.fill();
      break;
    case 'aircraft':
      g.beginPath();
      g.moveTo(cx, cy - 16);
      g.lineTo(cx, cy + 16);
      g.moveTo(cx - 20, cy);
      g.lineTo(cx + 20, cy);
      g.moveTo(cx - 8, cy + 14);
      g.lineTo(cx + 8, cy + 14);
      g.stroke();
      break;
    case 'bird':
      g.beginPath();
      g.moveTo(cx - 18, cy - 2);
      g.quadraticCurveTo(cx - 9, cy - 12, cx, cy + 2);
      g.quadraticCurveTo(cx + 9, cy - 12, cx + 18, cy - 2);
      g.stroke();
      break;
    default:
      g.font = '600 34px "IBM Plex Sans", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('?', cx, cy + 2);
  }
}

/** Sprite scale so the symbol is `px` CSS pixels tall regardless of distance (sizeAttenuation off). */
export function pixelScale(camera: THREE.PerspectiveCamera, viewportH: number, px: number): number {
  const p11 = camera.projectionMatrix.elements[5]!;
  return (2 * px) / (p11 * viewportH);
}

const urlCache = new Map<string, string>();
/** The same symbol as an image URL for lists and panels. */
export function symbolDataUrl(s: SymbolSpec): string {
  const key = `${s.aff}|${s.dim}|${s.fn}|${s.dashed ? 1 : 0}`;
  let u = urlCache.get(key);
  if (!u) {
    u = (symbolTexture({ ...s, selected: false }).image as HTMLCanvasElement).toDataURL();
    urlCache.set(key, u);
  }
  return u;
}
