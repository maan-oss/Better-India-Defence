import { useId, useState, type PointerEvent } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { motionTokens } from './arc/motion-tokens';

/**
 * Tiny inline trend line. It draws in from the left once, morphs when its values change, and a pointer moves a
 * marker along it to the nearest reading. `stretch` fills its container's width: it has no end dot, since the
 * aspect is not preserved, and its marker is a hairline.
 */
export function Spark({ values, width = 90, height = 26, color = 'var(--data)', fill = false, stretch = false }: { values: number[]; width?: number; height?: number; color?: string; fill?: boolean; stretch?: boolean }) {
  const id = useId();
  const reduced = !!useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  if (values.length < 2) return <svg className="spark" width={stretch ? '100%' : width} height={height} />;
  const max = Math.max(...values, 1e-9);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L${width} ${height} L0 ${height} Z`;
  const ease = [...motionTokens.ease.enter] as [number, number, number, number];
  const glide = reduced ? { duration: 0 } : motionTokens.spring.snappy;
  const at = hover ?? values.length - 1;
  const [hx, hy] = pts[at]!;
  const [lx, ly] = pts[pts.length - 1]!;
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - box.left) / box.width;
    setHover(Math.min(values.length - 1, Math.max(0, Math.round(f * (values.length - 1)))));
  };
  return (
    <svg
      className="spark"
      width={stretch ? '100%' : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={stretch ? 'none' : undefined}
      aria-hidden="true"
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <title>{values[at]!.toLocaleString()}</title>
      <defs>
        <clipPath id={`${id}-reveal`}>
          <motion.rect
            x={0}
            y={0}
            width={width}
            height={height}
            style={{ transformOrigin: '0px 0px' }}
            initial={reduced ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.9, ease }}
          />
        </clipPath>
        {fill && (
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.35" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        )}
      </defs>
      <g clipPath={`url(#${id}-reveal)`}>
        {fill && (
          <motion.path
            d={area}
            fill={`url(#${id})`}
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1, d: area }}
            transition={{ opacity: { duration: 0.6, delay: 0.2, ease }, d: { duration: motionTokens.duration.considered, ease: [...motionTokens.ease.standard] } }}
          />
        )}
        <motion.path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          animate={{ d }}
          transition={{ d: { duration: motionTokens.duration.considered, ease: [...motionTokens.ease.standard] } }}
        />
      </g>
      {!stretch && (
        <motion.g animate={{ x: lx, y: ly }} transition={glide}>
          <motion.circle r="2.2" fill={color} initial={reduced ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ ...motionTokens.spring.snappy, delay: reduced ? 0 : 0.8 }} />
        </motion.g>
      )}
      <motion.g style={{ pointerEvents: 'none' }} animate={{ x: hx, y: hy, opacity: hover === null ? 0 : 1 }} transition={{ x: glide, y: glide, opacity: { duration: motionTokens.duration.fast } }}>
        <line x1="0" x2="0" y1={-hy} y2={height - hy} stroke={color} strokeOpacity="0.4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {!stretch && <circle r="3" fill="var(--bg-1)" stroke={color} strokeWidth="1.5" />}
      </motion.g>
    </svg>
  );
}
