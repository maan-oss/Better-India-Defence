/**
 * The colour system for code that cannot read CSS variables (WebGL, canvas). Mirrors styles/tokens.css —
 * change both together. The standard display is light; the night display uses the dark set, and its red tint is
 * applied to canvases by a CSS filter.
 */
type Palette = Record<keyof typeof DARK, string>;

const DARK = {
  // Surfaces (ChatGPT-style neutral greys)
  bg0: '#000000',
  bg1: '#060101',
  bg2: '#0c0202',
  bg3: '#140303',
  // Text (Claude cream)
  text0: '#ff5a46',
  text1: '#ef5a48',
  text2: '#dc4b3b',
  text3: '#d6483a',
  // Interaction (cream: selection is the brightest neutral)
  accent: '#ff5a46',
  accent2: '#ff7a66',
  // Status (Radix red / orange / amber / grass / cyan 9)
  critical: '#ff2a1a',
  serious: '#ff6a30',
  caution: '#ff8a5a',
  normal: '#c8402e',
  standby: '#d94533',
  off: '#8a2a1e',
  // Affiliation (APP-6; Radix step 11)
  friend: '#e0503c',
  hostile: '#ff2a1a',
  suspect: '#ff6a30',
  neutral: '#b83a2a',
  unknownAff: '#ff8a5a',
  // Epistemic
  captured: '#ff5a46',
  reconstructed: '#f2604c',
  inferred: '#f0604c',
  prior: '#dc4b3b',
  // Static map context (neutral by design)
  terrain: '#1e1e1e',
  road: '#2b2b2b',
  roadMark: '#8a877f',
  building: '#3a3a3a',
  buildingEdge: '#c9c6bd',
  zone: '#c9c6bd',
  fence: '#9b988f',
  grid: '#a8a59d',
};

const LIGHT: Palette = {
  // Surfaces (Apple-style light greys: a grey page with white raised surfaces)
  bg0: '#e9e9ee',
  bg1: '#f5f5f7',
  bg2: '#ffffff',
  bg3: '#f0f0f3',
  // Text (ink)
  text0: '#1d1d1f',
  text1: '#3a3a3c',
  text2: '#5a5a5f',
  text3: '#6e6e73',
  // Interaction (ink; selection is the next step down)
  accent: '#1d1d1f',
  accent2: '#000000',
  // Status (Radix step 9; the darker text steps live in the CSS tokens)
  critical: '#e5484d',
  serious: '#f76b15',
  caution: '#ffc53d',
  normal: '#46a758',
  standby: '#00a2c7',
  off: '#8e8e93',
  // Affiliation (APP-6)
  friend: '#0071e3',
  hostile: '#d70015',
  suspect: '#c93400',
  neutral: '#248a3d',
  unknownAff: '#a16a00',
  // Epistemic
  captured: '#1d1d1f',
  reconstructed: '#00806f',
  inferred: '#6e46c8',
  prior: '#6e6e73',
  // Static map context (neutral by design)
  terrain: '#ececf0',
  road: '#d8d8de',
  roadMark: '#8e8e93',
  building: '#dcdce2',
  buildingEdge: '#6e6e73',
  zone: '#3a3a3c',
  fence: '#5a5a5f',
  grid: '#8e8e93',
};

/** The live palette. The standard display is light; components read it when they draw. */
export const P: Palette = { ...LIGHT };

/** Select the palette for a display: the light set, or the dark set behind the night display. */
export function applyPalette(theme: 'light' | 'night'): void {
  Object.assign(P, theme === 'night' ? DARK : LIGHT);
}

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
