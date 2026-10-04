/**
 * The colour system for code that cannot read CSS variables (WebGL, canvas). Mirrors styles/tokens.css —
 * change both together. Night mode is applied to canvases by a CSS filter, so these stay as defined.
 */
export const P = {
  // Surfaces
  bg0: '#0b131c',
  bg1: '#101b27',
  bg2: '#15222f',
  bg3: '#1b2c3d',
  // Text
  text0: '#eef3f8',
  text1: '#c1ccd8',
  text2: '#8796a8',
  text3: '#5b6b7d',
  // Interaction
  accent: '#4dacff',
  accent2: '#92cbff',
  // Status scale (Astro UXDS)
  critical: '#ff3838',
  serious: '#ffb302',
  caution: '#fce83a',
  normal: '#56f000',
  standby: '#2dccff',
  off: '#a4abb6',
  // Affiliation (APP-6)
  friend: '#3fc6ff',
  hostile: '#ff4747',
  suspect: '#ff9a3d',
  neutral: '#4cd964',
  unknownAff: '#ffe14d',
  // Epistemic
  captured: '#eef3f8',
  reconstructed: '#5fd4c4',
  inferred: '#b39dff',
  prior: '#8796a8',
  // Static map context (neutral by design)
  terrain: '#121d29',
  road: '#26384a',
  roadMark: '#7d8da0',
  building: '#33465a',
  buildingEdge: '#c1ccd8',
  zone: '#a9bbcf',
  fence: '#8fa2b8',
  grid: '#7fb4e6',
} as const;

/** `rgba()` from a palette hex. */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export const PRIORITY_COLOR: Record<string, string> = { critical: P.critical, high: P.serious, medium: P.caution, low: P.off };
export const LEVEL_COLOR: Record<string, string> = { CRITICAL: P.critical, HIGH: P.serious, MEDIUM: P.caution, LOW: P.off };

/** Coverage-quality ramp (three viridis stops): sequential, colour-blind safe, and distinct from status. */
const RAMP = [
  [0.27, 0.2, 0.49],
  [0.15, 0.5, 0.56],
  [0.63, 0.85, 0.22],
] as const;
export function qualityRamp(s: number): [number, number, number] {
  const v = Math.min(1, Math.max(0, s)) * 2;
  const i = Math.min(1, Math.floor(v));
  const k = v - i;
  const a = RAMP[i]!;
  const b = RAMP[i + 1]!;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
