/**
 * Brand moments: the boot sequence (the Core mark assembles — tile, strata drawn left to right, then the
 * observation lands on the ridge), the branded empty state and the not-found page.
 */
import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../components/kit';
import { Illustration, type ArtName } from './Illustration';
import { StrataField } from './StrataField';

const TOP = 'M2 32c6 0 9-12 16-12s8.5 8 13 8 6.5-10.5 13.5-10.5S54 27 62 31';
const MID = 'M2 42c8 0 11-4 17-4s9 3 14 3 8-3.5 14-3.5 9 3 15 4.5';
const LOW = 'M2 51c10 0 14-1.5 20-1.5s10 1.5 16 1.5 12-1.5 24-.5';
const ease = [0.23, 1, 0.32, 1] as const;

export function BootMark({ size = 56 }: { size?: number }) {
  const reduced = useReducedMotion() ?? false;
  const d = (s: number) => (reduced ? 0 : s);
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true" className="boot-mark">
      <clipPath id="boot-core">
        <rect x="5" y="5" width="54" height="54" rx="14" />
      </clipPath>
      <motion.rect x="5" y="5" width="54" height="54" rx="14" fill="currentColor" initial={{ scale: reduced ? 1 : 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: d(0.5), ease }} style={{ transformOrigin: '32px 32px' }} />
      <g clipPath="url(#boot-core)" stroke="var(--bg-chrome)" strokeLinecap="round" strokeLinejoin="round">
        {[
          [TOP, 4.6, 1, 0.25],
          [MID, 3.8, 0.6, 0.38],
          [LOW, 3.4, 0.34, 0.5],
        ].map(([path, w, o, delay]) => (
          <motion.path key={path as string} d={path as string} strokeWidth={w as number} opacity={o as number} initial={{ pathLength: reduced ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: d(0.7), delay: d(delay as number), ease }} />
        ))}
      </g>
      <motion.circle cx={44.5} cy={17.6} r={3.6} fill="currentColor" stroke="var(--bg-chrome)" strokeWidth={2.6} initial={{ scale: reduced ? 1 : 0, opacity: reduced ? 1 : 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 14, delay: d(0.95) }} style={{ transformOrigin: '44.5px 17.6px' }} />
    </svg>
  );
}

export function BootScreen({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="boot">
      <StrataField className="boot-art" width={1600} height={900} lines={26} seed={3} ruler={false} observations={0} relief={0.45} />
      <div className="boot-card">
        <BootMark />
        <motion.b className="wordmark boot-wm" initial={{ opacity: 0, letterSpacing: '0.6em' }} animate={{ opacity: 1, letterSpacing: '0.32em' }} transition={{ duration: 0.9, delay: 0.5, ease }}>
          STRATA
        </motion.b>
        <div className="boot-bar">
          <i />
        </div>
        <span>{label}</span>
        {children}
      </div>
    </div>
  );
}

/** Empty state with the brand illustration (Arc EmptyState underneath). */
export function Empty({ art = 'empty', title, description, action, compact }: { art?: ArtName; title: string; description: string; action?: ReactNode; compact?: boolean }) {
  return <EmptyState className={`brand-empty ${compact ? 'compact' : ''}`} icon={<Illustration name={art} size={compact ? 120 : 168} />} title={title} description={description} action={action} />;
}

export function NotFound() {
  const nav = useNavigate();
  return (
    <div className="page notfound">
      <StrataField className="nf-art" width={1600} height={900} lines={30} seed={404} ruler={false} observations={1} />
      <div className="nf-copy">
        <span className="mono muted">404 · NO RECORD</span>
        <h1>Nothing was ever observed here.</h1>
        <p className="muted">This address does not match any area of the console. Use the command bar (Ctrl K) to search, or return to the operational picture.</p>
        <div className="row">
          <button className="btn primary" onClick={() => nav('/operations')}>
            Operational picture
          </button>
          <button className="btn" onClick={() => nav(-1)}>
            Go back
          </button>
        </div>
      </div>
    </div>
  );
}
