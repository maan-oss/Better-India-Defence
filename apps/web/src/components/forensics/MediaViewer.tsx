import { useEffect, useMemo, useRef, useState } from 'react';
import { get, qs } from '../../api/client';
import type { Box, EvidenceItem, MediaDetection } from '../../api/vision';

export interface Overlay {
  persons: boolean;
  vehicles: boolean;
  faces: boolean;
  other: boolean;
}

/** Categorical (not status) colours for detection classes on imagery. */
const CAT_COLOR: Record<string, string> = { person: '#0bd8b6', vehicle: '#baa7ff', face: '#f3f1ea', aircraft: '#70b8ff', boat: '#70b8ff', animal: 'var(--text-2)', object: 'var(--text-2)' };

/**
 * Frame-accurate viewer for an evidence item. Frames are decoded server-side from the immutable original
 * (no browser transcoding), so what is shown is exactly what is analysed. Boxes are drawn in original-pixel
 * coordinates; a region of interest can be dragged out for enhancement or multi-frame fusion.
 */
export function MediaViewer({
  item,
  t,
  onT,
  roi,
  onRoi,
  roiMode,
  overlay,
  maxRoi,
}: {
  item: EvidenceItem;
  t: number;
  onT: (t: number) => void;
  roi: Box | null;
  onRoi: (b: Box | null) => void;
  roiMode: boolean;
  overlay: Overlay;
  maxRoi?: number;
}) {
  const W = item.width ?? 1280;
  const H = item.height ?? 720;
  const isVideo = item.kind === 'video';
  const src = `/api/evidence/items/${item.id}/frame?${qs({ t: isVideo ? t.toFixed(3) : undefined, w: 1920 })}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [dets, setDets] = useState<MediaDetection[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x0: number; y0: number } | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    get<MediaDetection[]>(`/api/evidence/items/${item.id}/detections?${qs({ t: isVideo ? t.toFixed(3) : undefined })}`, ctl.signal)
      .then(setDets)
      .catch(() => undefined);
    return () => ctl.abort();
  }, [item.id, t, isVideo, item.analysisStatus]);

  // Sequential playback: advance only after the previous frame has loaded (never queues requests).
  useEffect(() => {
    if (!playing || !isVideo || loaded !== src) return;
    const id = setTimeout(() => {
      const step = 1 / Math.min(item.fps ?? 4, 4);
      if (t + step > (item.durationS ?? 0)) setPlaying(false);
      else onT(Math.round((t + step) * 1000) / 1000);
    }, 120);
    return () => clearTimeout(id);
  }, [playing, loaded, src, t, isVideo, item.fps, item.durationS, onT]);

  const toImg = (e: React.PointerEvent): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(W, ((e.clientX - r.left) / r.width) * W)), y: Math.max(0, Math.min(H, ((e.clientY - r.top) / r.height) * H)) };
  };
  const clampBox = (b: Box): Box => {
    if (!maxRoi) return b;
    return { ...b, w: Math.min(b.w, maxRoi), h: Math.min(b.h, maxRoi) };
  };

  const shown = dets.filter((d) => (d.kind === 'face' ? overlay.faces : d.category === 'person' ? overlay.persons : d.category === 'vehicle' ? overlay.vehicles : overlay.other));
  const frameStep = 1 / (item.fps || 25);

  return (
    <div className="mv">
      <div className="mv-stage">
        <div className="mv-frame" style={{ aspectRatio: `${W} / ${H}` }}>
          <img src={src} alt={`${item.title}${isVideo ? ` at ${t.toFixed(2)} s` : ''}`} onLoad={() => setLoaded(src)} draggable={false} />
          {loaded !== src && <div className="mv-loading pulse">decoding frame…</div>}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className={roiMode ? 'roi-mode' : ''}
            onPointerDown={(e) => {
              if (!roiMode) return;
              (e.target as Element).setPointerCapture(e.pointerId);
              const p = toImg(e);
              drag.current = { x0: p.x, y0: p.y };
              setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              const p = toImg(e);
              setDraft(clampBox({ x: Math.min(p.x, drag.current.x0), y: Math.min(p.y, drag.current.y0), w: Math.abs(p.x - drag.current.x0), h: Math.abs(p.y - drag.current.y0) }));
            }}
            onPointerUp={() => {
              if (draft && draft.w > 6 && draft.h > 6) onRoi({ x: Math.round(draft.x), y: Math.round(draft.y), w: Math.round(draft.w), h: Math.round(draft.h) });
              drag.current = null;
              setDraft(null);
            }}
          >
            {shown.map((d, i) => {
              const c = CAT_COLOR[d.kind === 'face' ? 'face' : (d.category ?? 'object')] ?? 'var(--text-2)';
              const sw = Math.max(1.5, W / 700);
              return (
                <g key={i}>
                  <rect x={d.box.x} y={d.box.y} width={d.box.w} height={d.box.h} fill="none" stroke={c} strokeWidth={sw} strokeDasharray={d.kind === 'face' && d.quality?.grade === 'UNUSABLE' ? `${sw * 3} ${sw * 2}` : undefined} />
                  {(d.box.w > W / 40 || d.kind === 'face') && (
                    <text x={d.box.x} y={Math.max(10, d.box.y - sw * 2)} fill={c} fontSize={Math.max(11, W / 110)} fontFamily="JetBrains Mono Variable, monospace">
                      {d.kind === 'face' ? `face ${d.quality?.grade ?? ''}` : `${d.label} ${Math.round(d.score * 100)}`}
                    </text>
                  )}
                </g>
              );
            })}
            {(draft ?? roi) && (
              <rect className="roi" x={(draft ?? roi)!.x} y={(draft ?? roi)!.y} width={(draft ?? roi)!.w} height={(draft ?? roi)!.h} strokeWidth={Math.max(1.5, W / 600)} />
            )}
          </svg>
        </div>
      </div>
      <div className="mv-bar">
        {isVideo ? (
          <>
            <button className="btn small" title="Back 1 s" onClick={() => onT(Math.max(0, t - 1))}>
              −1s
            </button>
            <button className="btn small" title="Previous frame" onClick={() => onT(Math.max(0, +(t - frameStep).toFixed(3)))}>
              ◀|
            </button>
            <button className={`btn small ${playing ? 'on' : ''}`} onClick={() => setPlaying((p) => !p)}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <button className="btn small" title="Next frame" onClick={() => onT(Math.min(item.durationS ?? 0, +(t + frameStep).toFixed(3)))}>
              |▶
            </button>
            <button className="btn small" title="Forward 1 s" onClick={() => onT(Math.min(item.durationS ?? 0, t + 1))}>
              +1s
            </button>
            <span className="mono">
              {t.toFixed(3)} / {(item.durationS ?? 0).toFixed(1)} s
            </span>
            <span className="mono muted">{item.capturedAt ? new Date(item.capturedAt + t * 1000).toISOString().slice(11, 23) + 'Z' : ''}</span>
          </>
        ) : (
          <span className="muted">
            {W} × {H} px · original pixels
          </span>
        )}
        <div className="spacer" />
        {roi && (
          <span className="mono muted">
            ROI {roi.w}×{roi.h} @ {roi.x},{roi.y}
            <button className="btn small ghost" onClick={() => onRoi(null)} aria-label="Clear region">
              ✕
            </button>
          </span>
        )}
        <span className="muted">{shown.length} boxes</span>
      </div>
      {isVideo && <ActivityStrip item={item} t={t} onT={onT} />}
    </div>
  );
}

/** Persons / vehicles / faces over the clip from the analysis pass; click to seek. */
function ActivityStrip({ item, t, onT }: { item: EvidenceItem; t: number; onT: (t: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const tl = useMemo(() => item.analysis.timeline ?? [], [item.analysis.timeline]);
  const dur = item.durationS ?? 1;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = 46 * devicePixelRatio);
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    const maxP = Math.max(1, ...tl.map((x) => x.persons + x.vehicles));
    const bw = Math.max(1, (w / Math.max(40, tl.length)) * 0.7);
    for (const s of tl) {
      const x = (s.t / dur) * w;
      const hp = (s.persons / maxP) * (h - 12);
      const hv = (s.vehicles / maxP) * (h - 12);
      g.fillStyle = 'rgba(11,216,182,0.75)';
      g.fillRect(x, h - 8 - hp, bw, hp);
      g.fillStyle = 'rgba(186,167,255,0.7)';
      g.fillRect(x, h - 8 - hp - hv, bw, hv);
      if (s.faces) {
        g.fillStyle = '#f3f1ea';
        g.fillRect(x, h - 5, bw, 4);
      }
    }
    g.fillStyle = '#f3f1ea';
    g.fillRect((t / dur) * w - 1, 0, 2 * devicePixelRatio, h);
  }, [tl, t, dur]);
  return (
    <div className="mv-strip" title="Amber: people · grey: vehicles · white ticks: faces">
      <canvas
        ref={ref}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onT(Math.round(((e.clientX - r.left) / r.width) * dur * 1000) / 1000);
        }}
      />
      {!tl.length && <div className="muted mv-strip-empty">{item.analysisStatus === 'complete' ? 'No activity detected' : 'Analysis not yet available'}</div>}
    </div>
  );
}
