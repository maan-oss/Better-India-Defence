import { hashString, mulberry32, gaussian, normalizeVec } from '@strata/domain';

/**
 * Synthetic appearance signatures. In a real deployment an edge re-identification model would produce
 * these descriptors from pixels. Here each synthetic person has a fixed 16-D signature, and the first six
 * components also drive their rendered clothing colours so imagery and descriptors stay consistent.
 */
export function signatureFor(id: string): number[] {
  const rng = mulberry32(hashString(`sig:${id}`));
  return normalizeVec(Array.from({ length: 16 }, () => gaussian(rng)));
}

/** A deliberately similar signature (cosine ≈ 0.8) — used for a look-alike to exercise ambiguity handling. */
export function lookalike(base: number[], id: string, amount = 0.45): number[] {
  const rng = mulberry32(hashString(`look:${id}`));
  return normalizeVec(base.map((v) => v + amount * 0.25 * gaussian(rng)));
}

const PALETTE: [number, number, number][] = [
  [52, 58, 70],
  [140, 60, 46],
  [190, 170, 120],
  [60, 90, 70],
  [200, 200, 195],
  [35, 35, 38],
  [70, 95, 140],
  [150, 120, 70],
  [110, 30, 35],
  [225, 150, 40],
];

export function clothingColors(sig: number[]): { top: [number, number, number]; bottom: [number, number, number] } {
  const pick = (a: number, b: number, c: number) => {
    const idx = Math.abs(Math.floor((a * 7 + b * 13 + c * 17) * 10)) % PALETTE.length;
    return PALETTE[idx]!;
  };
  return { top: pick(sig[0]!, sig[1]!, sig[2]!), bottom: pick(sig[3]!, sig[4]!, sig[5]!) };
}
