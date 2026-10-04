/**
 * The STRATA motif: a stratigraphic section. Hairline strata follow a terrain profile and relax with depth, the
 * way layers of record lie under the present. Deterministic for a seed (same art on every console), drawn as SVG,
 * optionally drifting very slowly. A depth/time ruler and observation points make it read as an instrument,
 * not decoration.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Smooth 1-D value noise from a few octaves of random cosines. */
function makeNoise(seed: number) {
  const r = rng(seed);
  const waves = Array.from({ length: 6 }, (_, i) => ({ f: (0.6 + r() * 0.9) * 2 ** (i * 0.75), p: r() * Math.PI * 2, a: 1 / 1.7 ** i }));
  return (x: number, t: number) => waves.reduce((acc, w) => acc + w.a * Math.cos(x * w.f + w.p + t * (0.25 + w.f * 0.05)), 0);
}

export interface StrataFieldProps {
  width?: number;
  height?: number;
  lines?: number;
  seed?: number;
  /** Relative terrain relief, 0–1. */
  relief?: number;
  animate?: boolean;
  ruler?: boolean;
  observations?: number;
  className?: string;
}

export function StrataField({ width = 1200, height = 800, lines = 34, seed = 7, relief = 0.6, animate = false, ruler = true, observations = 3, className }: StrataFieldProps) {
  const noise = useMemo(() => makeNoise(seed), [seed]);
  const [t, setT] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let last = 0;
    const loop = (now: number) => {
      raf.current = requestAnimationFrame(loop);
      if (document.hidden || now - last < 66) return; // ~15 fps is plenty for a slow drift
      last = now;
      setT(now / 9000);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [animate]);

  const { paths, dots, ys } = useMemo(() => {
    const r = rng(seed * 7 + 3);
    const fold = makeNoise(seed + 101);
    const top = height * 0.34;
    const steps = 110;
    // Layer thicknesses vary like real beds: mostly thin, occasionally thick.
    const thick = Array.from({ length: lines }, () => 0.55 + r() ** 3 * 2.2);
    const sum = thick.reduce((a, b) => a + b, 0);
    const span = height * 0.62;
    const out: { d: string; o: number; w: number }[] = [];
    const ys: number[] = [];
    let ridge: { x: number; y: number }[] = [];
    let prev: { x: number; y: number }[] | null = null;
    let acc = 0;
    for (let i = 0; i < lines; i++) {
      const depth = i / (lines - 1);
      const base = top + (acc / sum) * span;
      ys.push(base);
      acc += thick[i]!;
      // The terrain's relief decays with depth; folding (its own slow wave) grows a little with depth.
      const amp = height * 0.2 * relief * (1 - depth) ** 1.9;
      const foldAmp = height * 0.035 * relief * Math.sin(depth * Math.PI) ;
      const pts: { x: number; y: number }[] = [];
      for (let s = 0; s <= steps; s++) {
        const x = (s / steps) * width;
        const u = (s / steps) * 4.2;
        let y = base - amp * (noise(u, t) * 0.5 + 0.45) + foldAmp * fold(u * 0.55 + 3, t * 0.4);
        // Strata never cross: each layer lies at least a third of its own thickness under the one above.
        if (prev) y = Math.max(y, prev[s]!.y + (span / sum) * thick[i - 1]! * 0.35);
        pts.push({ x, y });
      }
      if (i === 0) ridge = pts;
      prev = pts;
      let d = `M${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
      for (let s = 1; s < pts.length; s++) {
        const a = pts[s - 1]!;
        const b = pts[s]!;
        d += `Q${a.x.toFixed(1)} ${a.y.toFixed(1)} ${((a.x + b.x) / 2).toFixed(1)} ${((a.y + b.y) / 2).toFixed(1)}`;
      }
      const marker = thick[i]! > 1.6;
      out.push({ d, o: i === 0 ? 0.95 : (marker ? 0.62 : 0.42) * (1 - depth) ** 1.15 + 0.08, w: i === 0 ? 1.7 : marker ? 1.15 : 0.7 });
    }
    // Observations sit on the ridge's highest points, kept well apart so their labels never collide.
    const cand = ridge
      .map((p, i) => ({ ...p, i }))
      .filter((p, i, a) => i > 6 && i < a.length - 7 && p.y <= a[i - 2]!.y && p.y <= a[i + 2]!.y)
      .sort((a, b) => a.y - b.y);
    const picked: { x: number; y: number }[] = [];
    for (const c of cand) if (picked.length < observations && picked.every((q) => Math.abs(q.x - c.x) > width * 0.16)) picked.push(c);
    return { paths: out, dots: picked, ys };
  }, [noise, t, width, height, lines, relief, observations, seed]);

  return (
    <svg className={className} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        {paths.map((p, i) => (
          <path key={i} d={p.d} strokeWidth={p.w} opacity={p.o} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      {dots.map((d, i) => (
        <g key={i} transform={`translate(${d.x.toFixed(1)} ${d.y.toFixed(1)})`}>
          <line y1={-12} y2={-44} stroke="currentColor" strokeWidth={0.75} opacity={0.5} vectorEffect="non-scaling-stroke" />
          <circle r={4} fill="var(--bg-1, #212121)" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          <circle r={11} fill="none" stroke="currentColor" strokeWidth={0.75} opacity={0.35} vectorEffect="non-scaling-stroke" />
          <text x={6} y={-46} fill="currentColor" opacity={0.6} fontFamily="var(--font-mono)" fontSize={11} letterSpacing="0.06em">
            OBS·{String(i + 1).padStart(2, '0')}
          </text>
        </g>
      ))}
      {ruler && (
        <g stroke="currentColor" fill="currentColor" opacity={0.55} fontFamily="var(--font-mono)" fontSize={10.5} letterSpacing="0.06em">
          <line x1={width - 28} x2={width - 28} y1={ys[0]! - 20} y2={ys[ys.length - 1]!} strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
          {ys
            .filter((_, k) => k % 6 === 0)
            .map((y, k) => (
              <g key={k}>
                <line x1={width - 34} x2={width - 22} y1={y} y2={y} strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
                <text x={width - 40} y={y + 3.5} stroke="none" textAnchor="end">
                  {k === 0 ? 'NOW' : `T−${k * 6}h`}
                </text>
              </g>
            ))}
        </g>
      )}
    </svg>
  );
}
