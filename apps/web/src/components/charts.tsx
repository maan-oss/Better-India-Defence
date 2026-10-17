import { useId } from 'react';

/** Tiny inline trend line (SVG). */
/** `stretch` fills its container's width (no end marker, since the aspect is not preserved). */
export function Spark({ values, width = 90, height = 26, color = 'var(--data)', fill = false, stretch = false }: { values: number[]; width?: number; height?: number; color?: string; fill?: boolean; stretch?: boolean }) {
  const id = useId();
  if (values.length < 2) return <svg className="spark" width={stretch ? '100%' : width} height={height} />;
  const max = Math.max(...values, 1e-9);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  return (
    <svg className="spark" width={stretch ? '100%' : width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio={stretch ? 'none' : undefined} aria-hidden="true">
      {fill && (
        <>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.35" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${d} L${width} ${height} L0 ${height} Z`} fill={`url(#${id})`} />
        </>
      )}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {!stretch && <circle cx={pts[pts.length - 1]![0]} cy={pts[pts.length - 1]![1]} r="2.2" fill={color} />}
    </svg>
  );
}

