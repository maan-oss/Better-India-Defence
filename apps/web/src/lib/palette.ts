/**
 * The colour system for code that cannot read CSS variables (WebGL, canvas). Mirrors styles/tokens.css —
 * change both together. Night mode is applied to canvases by a CSS filter, so these stay as defined.
 */
export const P = {
  // Surfaces (ChatGPT-style neutral greys)
  bg0: '#171717',
  bg1: '#212121',
  bg2: '#2a2a2a',
  bg3: '#2f2f2f',
  // Text (Claude cream)
  text0: '#f3f1ea',
  text1: '#c9c6bd',
  text2: '#9b988f',
  text3: '#6e6c66',
  // Interaction (cream: selection is the brightest neutral)
  accent: '#f0eee6',
  accent2: '#faf9f5',
  // Status (Radix red / orange / amber / grass / cyan 9)
  critical: '#e5484d',
  serious: '#f76b15',
  caution: '#ffc53d',
  normal: '#46a758',
  standby: '#00a2c7',
  off: '#6e6c66',
  // Affiliation (APP-6; Radix step 11)
  friend: '#70b8ff',
  hostile: '#ff6369',
  suspect: '#ffa057',
  neutral: '#71d083',
  unknownAff: '#f5e147',
  // Epistemic
  captured: '#f3f1ea',
  reconstructed: '#0bd8b6',
  inferred: '#baa7ff',
  prior: '#9b988f',
  // Static map context (neutral by design)
  terrain: '#1e1e1e',
  road: '#2b2b2b',
  roadMark: '#8a877f',
  building: '#3a3a3a',
  buildingEdge: '#c9c6bd',
  zone: '#c9c6bd',
  fence: '#9b988f',
  grid: '#a8a59d',
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
