import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { EnuFrame, toMgrs, type FacilityDef } from '@strata/domain/client';
import type { WorldEngine } from '../engine/WorldEngine';

const NICE = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

/**
 * Map furniture for the 3-D picture: compass rose (click for north-up), scale bar at the view centre, and the
 * grid reference / elevation under the cursor. Updated at ~10 Hz, not every frame.
 */
export function MapHud({ engineRef, hostRef, facility }: { engineRef: RefObject<WorldEngine | null>; hostRef: RefObject<HTMLDivElement | null>; facility: FacilityDef }) {
  const [view, setView] = useState({ headingDeg: 0, mPerPx: 1, pitchDeg: -45 });
  const [cursor, setCursor] = useState<{ mgrs: string; elev: number; e: number; n: number } | null>(null);
  const frame = useMemo(() => new EnuFrame(facility.origin), [facility]);
  const pending = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      const v = e.viewInfo();
      setView((p) => (Math.abs(p.headingDeg - v.headingDeg) > 0.3 || Math.abs(p.mPerPx - v.mPerPx) / p.mPerPx > 0.01 || Math.abs(p.pitchDeg - v.pitchDeg) > 0.5 ? v : p));
      const c = pending.current;
      if (c) {
        pending.current = null;
        const g = e.groundPoint(c.x, c.y);
        if (!g) setCursor(null);
        else {
          const geo = frame.toGeodetic(g);
          let mgrs = '—';
          try {
            mgrs = toMgrs(geo.lat, geo.lon, 5, true);
          } catch {
            /* outside MGRS coverage */
          }
          setCursor({ mgrs, elev: facility.origin.alt + g.z, e: g.x, n: g.y });
        }
      }
    }, 100);
    const host = hostRef.current;
    const move = (ev: PointerEvent) => (pending.current = { x: ev.clientX, y: ev.clientY });
    const leave = () => setCursor(null);
    host?.addEventListener('pointermove', move);
    host?.addEventListener('pointerleave', leave);
    return () => {
      clearInterval(id);
      host?.removeEventListener('pointermove', move);
      host?.removeEventListener('pointerleave', leave);
    };
  }, [engineRef, hostRef, frame, facility]);

  const maxPx = 120;
  const metres = NICE.filter((m) => m / view.mPerPx <= maxPx).pop() ?? NICE[0]!;
  const px = Math.max(8, metres / view.mPerPx);

  return (
    <>
      {/* Flagged when the map points north, so the phone can hide the compass until it is useful to reset it. */}
      <button className="compass glass" data-map-chrome data-north={Math.abs(((view.headingDeg % 360) + 540) % 360 - 180) < 0.5 ? 'true' : undefined} onClick={() => engineRef.current?.northUp()} title="Click for north-up">
        <svg aria-hidden="true" viewBox="-50 -50 100 100" width="64" height="64" style={{ transform: `rotate(${-view.headingDeg}deg)` }}>
          {Array.from({ length: 36 }, (_, i) => (
            <line key={i} x1="0" y1={-44} x2="0" y2={i % 9 === 0 ? -36 : -40} stroke={i % 9 === 0 ? 'var(--text-1)' : 'var(--text-3)'} strokeWidth={i % 9 === 0 ? 1.6 : 1} transform={`rotate(${i * 10})`} />
          ))}
          <path d="M0 -30 L7 0 L0 -5 L-7 0 Z" fill="var(--red)" />
          <path d="M0 30 L7 0 L0 5 L-7 0 Z" fill="var(--text-2)" />
          <text y="-17" textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text-0)" transform={`rotate(${view.headingDeg} 0 -21)`}>
            N
          </text>
        </svg>
        <span className="mono">{String(Math.round(view.headingDeg) % 360).padStart(3, '0')}°</span>
      </button>
      <div className="scalebar" data-map-chrome aria-label={`Scale ${metres} metres`}>
        <div className="sb-bar" style={{ width: px }}>
          <i />
          <i />
        </div>
        <span className="mono">{metres >= 1000 ? `${metres / 1000} km` : `${metres} m`}</span>
      </div>
      {/* Shown only while the pointer is over the map; an always-on hint competes with the picture it describes. */}
      {cursor && (
        <div className="cursor-ref glass mono on" aria-live="off">
          <b>{cursor.mgrs}</b>
          <span>elev {cursor.elev.toFixed(0)} m</span>
          <span className="dim">
            E{cursor.e.toFixed(0)} N{cursor.n.toFixed(0)}
          </span>
        </div>
      )}
    </>
  );
}
