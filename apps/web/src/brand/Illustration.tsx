/**
 * Empty-state illustrations. One construction for all of them: an isometric block of ground cut to show its
 * strata, contours on its top face, and a single object standing on it. Cream hairlines (currentColor), faces
 * shaded by a few percent only, so they sit quietly in the dark UI and survive night (red-light) mode.
 */
import type { ReactNode } from 'react';

export type ArtName = 'cameras' | 'incidents' | 'evidence' | 'identity' | 'tasks' | 'sensors' | 'search' | 'offline' | 'audit' | 'reconstructions' | 'site' | 'empty';

const H = 27.7; // half-size of the top face in iso units
const iso = (x: number, y: number, z = 0): [number, number] => [80 + (x - y) * 0.866, 74 + (x + y) * 0.5 - z];
const P = (...pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
/** An iso ellipse (a circle on the ground plane) centred at (x, y). */
const ell = (x: number, y: number, r: number, z = 0) => {
  const [cx, cy] = iso(x, y, z);
  return { cx, cy, rx: r * 1.22, ry: r * 0.71 };
};

function Block({ children }: { children?: ReactNode }) {
  const D = 24; // depth of the cut
  const top = P(iso(-H, -H), iso(H, -H), iso(H, H), iso(-H, H)) + 'Z';
  const left = P(iso(-H, H), iso(H, H), iso(H, H, -D), iso(-H, H, -D)) + 'Z';
  const right = P(iso(H, -H), iso(H, H), iso(H, H, -D), iso(H, -H, -D)) + 'Z';
  const strata = [7, 13.5, 19];
  return (
    <g fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round">
      <path d={left} fill="currentColor" fillOpacity={0.03} />
      <path d={right} fill="currentColor" fillOpacity={0.07} />
      <path d={top} fill="currentColor" fillOpacity={0.045} />
      {/* strata on the cut faces, gently undulating */}
      {strata.map((d, i) => (
        <g key={d} opacity={0.62 - i * 0.16}>
          <path d={`M${iso(-H, H, -d).join(' ')}Q${iso(-H / 3, H, -d - 2.5 + i).join(' ')} ${iso(0, H, -d).join(' ')}T${iso(H, H, -d).join(' ')}`} />
          <path d={`M${iso(H, H, -d).join(' ')}Q${iso(H, H / 3, -d + 2).join(' ')} ${iso(H, 0, -d).join(' ')}T${iso(H, -H, -d).join(' ')}`} />
        </g>
      ))}
      {/* contours on the ground */}
      <g opacity={0.28}>
        <ellipse {...ell(-12, 12, 9)} />
        <ellipse {...ell(-12, 12, 4.5)} />
        <ellipse {...ell(14, -14, 6)} />
      </g>
      {children}
    </g>
  );
}

const Drop = ({ x, y, z }: { x: number; y: number; z: number }) => {
  const [ax, ay] = iso(x, y, z);
  const [bx, by] = iso(x, y, 0);
  return (
    <>
      <path d={`M${ax} ${ay}L${bx} ${by}`} strokeDasharray="2 3" opacity={0.6} />
      <ellipse {...ell(x, y, 2.4)} fill="currentColor" fillOpacity={0.5} stroke="none" />
    </>
  );
};

const objects: Record<ArtName, () => ReactNode> = {
  empty: () => (
    <>
      <Drop x={0} y={0} z={26} />
      <circle cx={iso(0, 0, 30)[0]} cy={iso(0, 0, 30)[1]} r={4} fill="var(--bg-1)" />
    </>
  ),
  site: () => (
    <>
      <path d={P(iso(-18, -18), iso(18, -18), iso(18, 18), iso(-18, 18)) + 'Z'} strokeDasharray="3 3" />
      {[iso(-18, -18), iso(18, -18), iso(18, 18), iso(-18, 18)].map(([x, y], i) => (
        <rect key={i} x={x - 2} y={y - 2} width={4} height={4} fill="var(--bg-1)" />
      ))}
      <Drop x={0} y={0} z={30} />
      <path d={`M${iso(0, 0, 30).join(' ')}l0 -10l9 4l-9 4`} fill="currentColor" fillOpacity={0.4} />
    </>
  ),
  cameras: () => {
    const [px, py] = iso(-6, 6, 0);
    const [tx, ty] = iso(-6, 6, 38);
    return (
      <>
        <path d={`M${px} ${py}L${tx} ${ty}`} strokeWidth={1.75} />
        <path d={`M${tx - 3} ${ty + 1}l15 -6l4 6l-15 6z`} fill="var(--bg-2)" />
        <path d={`M${tx + 14} ${ty - 2}l4 2`} />
        {/* field of view on the ground */}
        <path d={`M${tx + 16} ${ty}L${iso(22, -10)[0]} ${iso(22, -10)[1]}M${tx + 16} ${ty}L${iso(16, 14)[0]} ${iso(16, 14)[1]}`} strokeDasharray="2 3" opacity={0.6} />
        <path d={`M${iso(22, -10).join(' ')}Q${iso(26, 4).join(' ')} ${iso(16, 14).join(' ')}`} opacity={0.6} />
      </>
    );
  },
  incidents: () => {
    const [bx, by] = iso(4, -2, 0);
    return (
      <>
        <ellipse {...ell(4, -2, 14)} strokeDasharray="3 3" opacity={0.55} />
        <ellipse {...ell(4, -2, 7)} opacity={0.7} />
        <path d={`M${bx} ${by}c-2-8-11-14-11-22a11 11 0 0 1 22 0c0 8-9 14-11 22z`} fill="var(--bg-2)" strokeWidth={1.5} />
        <circle cx={bx} cy={by - 22} r={4} />
      </>
    );
  },
  evidence: () => (
    <>
      {[0, 1, 2].map((i) => {
        const z = 14 + i * 9;
        const pts = [iso(-14 + i * 3, -10, z), iso(12 + i * 3, -10, z), iso(12 + i * 3, 12, z), iso(-14 + i * 3, 12, z)];
        return <path key={i} d={P(...pts) + 'Z'} fill="var(--bg-2)" opacity={1 - (2 - i) * 0.2} />;
      })}
      <path d={P(iso(-6, -2, 32), iso(6, -2, 32))} opacity={0.6} />
      <path d={P(iso(-6, 3, 32), iso(2, 3, 32))} opacity={0.6} />
    </>
  ),
  identity: () => {
    const [cx, cy] = iso(0, 0, 40);
    return (
      <>
        <Drop x={0} y={0} z={20} />
        <g transform={`translate(${cx} ${cy})`}>
          <path d="M-18 -10v-8h8M10 -18h8v8M18 10v8h-8M-10 18h-8v-8" strokeWidth={1.5} />
          <circle r={5.5} cy={-3} fill="var(--bg-2)" />
          <path d="M-9 12c1-6 5-8 9-8s8 2 9 8" />
        </g>
      </>
    );
  },
  tasks: () => {
    const [fx, fy] = iso(14, -12, 0);
    return (
      <>
        <path d={`M${iso(-20, 16).join(' ')}Q${iso(-4, 18).join(' ')} ${iso(0, 4).join(' ')}T${iso(14, -12).join(' ')}`} strokeDasharray="2 3" opacity={0.7} />
        <circle cx={iso(-20, 16)[0]} cy={iso(-20, 16)[1]} r={2.5} fill="currentColor" />
        <path d={`M${fx} ${fy}v-30`} strokeWidth={1.6} />
        <path d={`M${fx} ${fy - 30}l16 5l-16 6z`} fill="currentColor" fillOpacity={0.35} />
      </>
    );
  },
  sensors: () => {
    const [bx, by] = iso(0, 0, 0);
    return (
      <>
        <path d={`M${bx - 7} ${by}L${bx} ${by - 34}L${bx + 7} ${by}M${bx - 4.5} ${by - 12}h9M${bx - 2.5} ${by - 23}h5`} strokeWidth={1.4} />
        <circle cx={bx} cy={by - 36} r={2.5} fill="currentColor" />
        {[9, 15, 21].map((r, i) => (
          <g key={r} opacity={0.75 - i * 0.2}>
            <path d={`M${bx - r * 0.7} ${by - 36 - r * 0.7}a${r} ${r} 0 0 0 0 ${r * 1.4}`} />
            <path d={`M${bx + r * 0.7} ${by - 36 - r * 0.7}a${r} ${r} 0 0 1 0 ${r * 1.4}`} />
          </g>
        ))}
      </>
    );
  },
  search: () => {
    const [cx, cy] = iso(-2, 2, 36);
    return (
      <>
        <ellipse {...ell(-2, 2, 15)} strokeDasharray="3 3" opacity={0.55} />
        <circle cx={cx} cy={cy} r={11} fill="var(--bg-2)" strokeWidth={1.6} />
        <path d={`M${cx + 8} ${cy + 8}l10 10`} strokeWidth={2.4} />
        <path d={`M${cx - 5} ${cy - 3}a6 6 0 0 1 6 -5`} opacity={0.6} />
      </>
    );
  },
  offline: () => {
    const [ax, ay] = iso(-16, 10, 22);
    const [bx, by] = iso(16, -10, 22);
    return (
      <>
        <path d={`M${ax} ${ay}L${ax + 18} ${ay - 9}`} strokeWidth={1.6} />
        <path d={`M${bx} ${by}L${bx - 18} ${by + 9}`} strokeWidth={1.6} />
        <path d={`M${ax + 22} ${ay - 16}l3 5l-4 2l3 5`} />
        <circle cx={ax} cy={ay} r={3} fill="var(--bg-1)" />
        <circle cx={bx} cy={by} r={3} fill="var(--bg-1)" />
        <Drop x={-16} y={10} z={19} />
        <Drop x={16} y={-10} z={19} />
      </>
    );
  },
  audit: () => {
    const [cx, cy] = iso(0, 0, 32);
    return (
      <>
        <Drop x={0} y={0} z={18} />
        <g transform={`translate(${cx} ${cy}) rotate(-26)`}>
          {[-17, 0, 17].map((x, i) => (
            <rect key={x} x={x - 9} y={-5} width={18} height={10} rx={5} fill={i === 1 ? 'var(--bg-2)' : 'none'} strokeWidth={1.5} />
          ))}
        </g>
      </>
    );
  },
  reconstructions: () => {
    const z0 = 18;
    const s = 11;
    const b = [iso(-s, -s, z0), iso(s, -s, z0), iso(s, s, z0), iso(-s, s, z0)];
    const t = [iso(-s, -s, z0 + 20), iso(s, -s, z0 + 20), iso(s, s, z0 + 20), iso(-s, s, z0 + 20)];
    return (
      <>
        <path d={P(...t) + 'Z'} fill="var(--bg-2)" />
        <path d={P(...b) + 'Z'} strokeDasharray="2 2" opacity={0.6} />
        {b.map((p, i) => (
          <path key={i} d={P(p, t[i]!)} strokeDasharray={i === 0 ? '2 2' : undefined} opacity={i === 0 ? 0.5 : 1} />
        ))}
        {t.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={1.8} fill="currentColor" />
        ))}
        <Drop x={0} y={0} z={z0} />
      </>
    );
  },
};

export function Illustration({ name, size = 160, className }: { name: ArtName; size?: number; className?: string }) {
  const O = objects[name];
  return (
    <svg className={`illus ${className ?? ''}`} width={size} height={size * 0.8} viewBox="0 0 160 128" aria-hidden="true">
      <Block>
        <O />
      </Block>
    </svg>
  );
}
