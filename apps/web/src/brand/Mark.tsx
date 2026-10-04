/**
 * STRATA identity: the Core mark — a core sample cut through stratified ground. The top stratum is the terrain
 * profile with one observation on its ridge; the strata below soften with depth (the record under the present).
 * See docs/BRAND.md for construction, clear space and usage.
 */
import { useId } from 'react';

const TOP = 'M2 32c6 0 9-12 16-12s8.5 8 13 8 6.5-10.5 13.5-10.5S54 27 62 31';
const MID = 'M2 42c8 0 11-4 17-4s9 3 14 3 8-3.5 14-3.5 9 3 15 4.5';
const LOW = 'M2 51c10 0 14-1.5 20-1.5s10 1.5 16 1.5 12-1.5 24-.5';
/** The observation: a point on the ridge. */
const DOT = { cx: 44.5, cy: 17.6 };

export function Mark({ size = 24, variant = 'solid', title, className }: { size?: number; variant?: 'solid' | 'line'; title?: string; className?: string }) {
  const id = useId().replace(/:/g, '');
  const solid = variant === 'solid';
  // Strokes thicken slightly at small sizes so the strata survive at 16 px.
  const k = size <= 20 ? 1.18 : size <= 32 ? 1.08 : 1;
  const ink = solid ? 'var(--brand-ink, #1f1e1d)' : 'currentColor';
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <clipPath id={`core-${id}`}>
          <rect x="5" y="5" width="54" height="54" rx="14" />
        </clipPath>
      </defs>
      {solid ? <rect x="5" y="5" width="54" height="54" rx="14" fill="currentColor" /> : <rect x="6.25" y="6.25" width="51.5" height="51.5" rx="12.75" stroke="currentColor" strokeWidth={2.5 * k} />}
      <g clipPath={`url(#core-${id})`} stroke={ink} strokeLinecap="round" strokeLinejoin="round">
        <path d={TOP} strokeWidth={4.6 * k} />
        <path d={MID} strokeWidth={3.8 * k} opacity={solid ? 0.6 : 0.58} />
        <path d={LOW} strokeWidth={3.4 * k} opacity={solid ? 0.34 : 0.3} />
      </g>
      <circle cx={DOT.cx} cy={DOT.cy} r={3.6 * k} fill={solid ? 'currentColor' : 'var(--bg-1, #212121)'} stroke={ink} strokeWidth={2.6 * k} />
    </svg>
  );
}

/** Wordmark: STRATA set in Geist semibold with wide tracking (0.32em), optically centred. */
export function Wordmark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span className={`wordmark ${className ?? ''}`} style={{ fontSize: size }} aria-label="Strata">
      STRATA
    </span>
  );
}

export function Lockup({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span className={`lockup ${className ?? ''}`}>
      <Mark size={size} />
      <Wordmark size={Math.round(size * 0.52)} />
    </span>
  );
}

/** The mark as a standalone SVG string (favicon, manifest icons, exports). */
export function markSvg(fg = '#f0eee6', ink = '#1f1e1d', bg?: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${bg ? `<rect width="64" height="64" fill="${bg}"/>` : ''}<clipPath id="c"><rect x="5" y="5" width="54" height="54" rx="14"/></clipPath><rect x="5" y="5" width="54" height="54" rx="14" fill="${fg}"/><g clip-path="url(#c)" fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round"><path d="${TOP}" stroke-width="5.4"/><path d="${MID}" stroke-width="4.5" opacity=".6"/><path d="${LOW}" stroke-width="4" opacity=".34"/></g><circle cx="${DOT.cx}" cy="${DOT.cy}" r="4.2" fill="${fg}" stroke="${ink}" stroke-width="3"/></svg>`;
}
