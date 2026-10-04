import { useId } from 'react';

/** Tiny inline trend line (SVG). */
/** `stretch` fills its container's width (no end marker, since the aspect is not preserved). */
export function Spark({ values, width = 90, height = 26, color = 'var(--data)', fill = true, stretch = false }: { values: number[]; width?: number; height?: number; color?: string; fill?: boolean; stretch?: boolean }) {
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

/** Responsive area chart with gridlines and y labels (SVG, scales to its container width). */
export function AreaChart({ values, labels, height = 120, color = 'var(--data)', unit = '' }: { values: number[]; labels?: string[]; height?: number; color?: string; unit?: string }) {
  const id = useId();
  const W = 600;
  const H = height;
  const padL = 34;
  const padB = labels ? 16 : 4;
  const max = niceMax(Math.max(...values, 1));
  const n = Math.max(2, values.length);
  const x = (i: number) => padL + (i / (n - 1)) * (W - padL - 4);
  const y = (v: number) => 4 + (1 - v / max) * (H - padB - 8);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const ticks = [0, max / 2, max];
  return (
    <svg className="areachart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H} role="img" aria-label="trend chart">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.32" />
          <stop offset="1" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--line)" />
          <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--text-3)" fontFamily="JetBrains Mono Variable, monospace">
            {fmt(t)}
            {unit}
          </text>
        </g>
      ))}
      {values.length > 1 && (
        <>
          <path d={`${d} L${x(values.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} fill={`url(#${id})`} />
          <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </>
      )}
      {labels?.map((l, i) =>
        l ? (
          <text key={i} x={x(i)} y={H - 3} textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'} fontSize="10" fill="var(--text-3)" fontFamily="JetBrains Mono Variable, monospace">
            {l}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function niceMax(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
const fmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v % 1 ? v.toFixed(1) : String(v));

/** Horizontal meter 0–1 with threshold colouring. */
export function Meter({ value, warn = 0.7, bad = 0.9 }: { value: number; warn?: number; bad?: number }) {
  const v = Math.max(0, Math.min(1, value));
  const color = v >= bad ? 'var(--red)' : v >= warn ? 'var(--amber)' : 'var(--ok)';
  return (
    <div className="meter" role="meter" aria-valuenow={Math.round(v * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${v * 100}%`, background: color }} />
    </div>
  );
}
