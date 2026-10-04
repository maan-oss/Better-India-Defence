/** Deterministic PRNG utilities. Every synthetic value in the platform is reproducible from a seed. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash; used to derive stable per-entity seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stateless hash of integer coordinates → [0,1). Used for noise that must be a pure function of (key, t). */
export function hash01(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h ^= Math.imul((p | 0) ^ ((p / 4294967296) | 0), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

/** Standard normal sample from two uniforms (Box–Muller). */
export function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Deterministic gaussian as a pure function of integer keys. */
export function gaussianAt(...parts: number[]): number {
  const u = Math.max(hash01(...parts, 1), 1e-12);
  const v = hash01(...parts, 2);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
