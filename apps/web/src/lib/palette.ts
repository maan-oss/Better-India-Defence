/**
 * The colour system for code that cannot read CSS variables (WebGL, canvas). Mirrors styles/tokens.css —
 * change both together. Night mode is applied to canvases by a CSS filter, so these stay as defined.
 */
export const P = {
  // Surfaces (Radix Slate dark)
  bg0: '#0c0d0e',
  bg1: '#111113',
  bg2: '#18191b',
  bg3: '#212225',
  // Text
  text0: '#edeef0',
  text1: '#b0b4ba',
  text2: '#8b8f98',
  text3: '#62666e',
  // Interaction (neutral: selection is the brightest neutral)
  accent: '#edeef0',
  accent2: '#ffffff',
  // Status (Radix red / orange / amber / grass / cyan 9)
  critical: '#e5484d',
  serious: '#f76b15',
  caution: '#ffc53d',
  normal: '#46a758',
  standby: '#00a2c7',
  off: '#696e77',
  // Affiliation (APP-6; Radix step 11)
  friend: '#70b8ff',
  hostile: '#ff6369',
  suspect: '#ffa057',
  neutral: '#71d083',
  unknownAff: '#f5e147',
  // Epistemic
  captured: '#edeef0',
  reconstructed: '#0bd8b6',
  inferred: '#baa7ff',
  prior: '#8b8f98',
  // Static map context (neutral by design)
  terrain: '#161719',
  road: '#26282b',
  roadMark: '#777b84',
  building: '#363a3f',
  buildingEdge: '#b0b4ba',
  zone: '#b0b4ba',
  fence: '#8b8f98',
  grid: '#9ba1aa',
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
