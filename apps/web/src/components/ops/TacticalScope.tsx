import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorld } from '../../state/world';
import { useOps } from '../../state/ops';
import { useTime } from '../../state/time';
import { tracks as trackStore, type RenderTrack } from '../../state/tracks';
import { symbolFor, symbolTexture } from '../../engine/symbols';
import { alpha, LEVEL_COLOR, P as C } from '../../lib/palette';


/**
 * Plan-position display of the site: perimeter, restricted zones, vital-asset protection rings, every track
 * with its tactical symbol, and threat vectors to the assets they threaten. North up. Click a contact to
 * open it in the operational picture.
 */
export function TacticalScope() {
  const ref = useRef<HTMLCanvasElement>(null);
  const facility = useWorld((s) => s.facility);
  const nav = useNavigate();
  const [hover, setHover] = useState<{ x: number; y: number; tr: RenderTrack } | null>(null);
  const hits = useRef<{ x: number; y: number; tr: RenderTrack }[]>([]);
  const [rangeM, setRangeM] = useState<number | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !facility) return;
    const ctx = cv.getContext('2d')!;
    let raf = 0;
    let list: RenderTrack[] = [];
    let lastPull = 0;
    const t0 = performance.now();
    const R = rangeM ?? Math.max(400, facility.perimeterHalfM * 1.3);
    const css = getComputedStyle(document.documentElement);
    const col = (v: string, f: string) => css.getPropertyValue(v).trim() || f;
    const text1 = col('--text-1', C.text1);
    const text2 = col('--text-2', C.text2);
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - lastPull > 1000) {
        lastPull = now;
        const tm = useTime.getState();
        list = tm.mode === 'live' ? trackStore.liveAt(tm.currentLiveEdge()) : trackStore.replayAt(tm.t);
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const rad = Math.min(w, h) / 2 - 14;
      const k = rad / R;
      const P = (x: number, y: number) => [cx + x * k, cy - y * k] as const;
      // Scope background and range rings.
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      bg.addColorStop(0, alpha(C.bg3, 0.7));
      bg.addColorStop(1, alpha(C.bg0, 0.3));
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();
      const step = niceStep(R / 4);
      ctx.font = '10px "IBM Plex Mono", monospace';
      for (let r = step; r <= R + 1; r += step) {
        ctx.strokeStyle = alpha(C.grid, 0.14);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, r * k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = text2;
        ctx.fillText(r >= 1000 ? `${r / 1000} km` : `${r} m`, cx + 4, cy - r * k + 12);
      }
      ctx.strokeStyle = alpha(C.grid, 0.08);
      for (let a = 0; a < 12; a++) {
        const ang = (a * Math.PI) / 6;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.sin(ang) * rad, cy - Math.cos(ang) * rad);
        ctx.stroke();
      }
      ctx.fillStyle = text2;
      ctx.textAlign = 'center';
      ctx.fillText('N', cx, cy - rad - 3);
      ctx.textAlign = 'left';
      // Perimeter and restricted zones.
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.clip();
      ctx.strokeStyle = alpha(C.fence, 0.7);
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (const f of facility.fence) {
        const [ax, ay] = P(f.a.x, f.a.y);
        const [bx, by] = P(f.b.x, f.b.y);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for (const z of facility.zones) {
        if (!z.restricted) continue;
        ctx.beginPath();
        z.polygon.forEach((p, i) => {
          const [x, y] = P(p.x, p.y);
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = alpha(C.zone, 0.05);
        ctx.fill();
        ctx.strokeStyle = alpha(C.zone, 0.4);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // Buildings as faint footprints.
      ctx.fillStyle = alpha(C.zone, 0.1);
      for (const b of facility.buildings) {
        const [x, y] = P(b.center.x, b.center.y);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate((-b.yawDeg * Math.PI) / 180);
        ctx.fillRect((-b.width / 2) * k, (-b.depth / 2) * k, b.width * k, b.depth * k);
        ctx.restore();
      }
      // Vital assets.
      const ops = useOps.getState();
      for (const v of ops.vitalAssets) {
        const [x, y] = P(v.centre.x, v.centre.y);
        ctx.strokeStyle = alpha(C.zone, v.priority === 1 ? 0.75 : 0.4);
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(4, v.radiusM * k), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = v.priority === 1 ? text1 : text2;
        ctx.font = '9.5px "IBM Plex Sans", sans-serif';
        ctx.fillText(v.name.toUpperCase(), x + Math.max(4, v.radiusM * k) + 3, y + 3);
      }
      // Threat vectors.
      for (const th of ops.threats) {
        if (th.level !== 'CRITICAL' && th.level !== 'HIGH') continue;
        const v = ops.vitalAssets.find((a) => a.id === th.assetId);
        if (!v) continue;
        const [x1, y1] = P(th.position.x, th.position.y);
        const [x2, y2] = P(v.centre.x, v.centre.y);
        ctx.strokeStyle = LEVEL_COLOR[th.level]!;
        ctx.lineWidth = th.level === 'CRITICAL' ? 2 : 1.4;
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = -((now - t0) / 60) % 9;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Sweep.
      const ang = ((now - t0) / 1000) * 0.9;
      const g = ctx.createConicGradient(ang - Math.PI / 2 - 0.8, cx, cy);
      g.addColorStop(0, alpha(C.grid, 0));
      g.addColorStop(0.127, alpha(C.grid, 0.12));
      g.addColorStop(0.128, alpha(C.grid, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();
      // Tracks.
      const hitList: typeof hits.current = [];
      const sorted = [...list].sort((a, b) => Number(b.cooperative) - Number(a.cooperative));
      for (const tr of sorted) {
        const [x, y] = P(tr.position.x, tr.position.y);
        if (Math.hypot(x - cx, y - cy) > rad) continue;
        const spec = symbolFor(tr, false);
        const img = symbolTexture(spec).image as HTMLCanvasElement;
        const s = tr.cooperative ? 16 : 20;
        // Velocity leader: where it will be in 60 s.
        if (!tr.inferred && tr.trail.length > 1) {
          const a = tr.trail[tr.trail.length - 2]!;
          const b = tr.trail[tr.trail.length - 1]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len > 0.5) {
            ctx.strokeStyle = alpha(C.text0, 0.4);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + (dx / len) * 14, y - (dy / len) * 14);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = tr.inferred ? 0.55 : 1;
        ctx.drawImage(img, x - s / 2, y - s / 2, s, s);
        ctx.globalAlpha = 1;
        if (!tr.cooperative) {
          ctx.fillStyle = alpha(C.text0, 0.8);
          ctx.font = '9.5px "IBM Plex Mono", monospace';
          ctx.fillText(tr.id, x + s / 2 + 2, y + 3);
        }
        hitList.push({ x, y, tr });
      }
      ctx.restore();
      ctx.strokeStyle = alpha(C.grid, 0.3);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.stroke();
      hits.current = hitList;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [facility, rangeM]);

  const near = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: (typeof hits.current)[number] | null = null;
    let bd = 14;
    for (const h of hits.current) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  };
  const max = facility ? Math.max(400, facility.perimeterHalfM * 1.3) : 2000;
  return (
    <section className="panel cmd-scope">
      <div className="panel-h">
        <h3>Tactical scope</h3>
        <span className="spacer" />
        <div className="seg">
          {[max, Math.round(max / 2), Math.round(max / 4)].map((r, i) => (
            <button key={r} className={(rangeM ?? max) === r ? 'on' : ''} onClick={() => setRangeM(i === 0 ? null : r)}>
              {r >= 1000 ? `${(r / 1000).toFixed(1)} km` : `${r} m`}
            </button>
          ))}
        </div>
      </div>
      <div className="scope-wrap">
        <canvas
          ref={ref}
          onMouseMove={(e) => {
            const h = near(e);
            setHover(h ? { x: h.x, y: h.y, tr: h.tr } : null);
            (e.target as HTMLCanvasElement).style.cursor = h ? 'pointer' : 'default';
          }}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const h = near(e);
            if (!h) return;
            nav('/operations');
            useWorld.getState().select({ kind: 'track', id: h.tr.id });
            useWorld.getState().flyTo(h.tr.position, 220);
          }}
          aria-label="Tactical scope: plan view of tracks and vital assets"
        />
        {hover && (
          <div className="scope-tip glass" style={{ left: hover.x + 14, top: hover.y - 10 }}>
            <b className="mono">{hover.tr.cooperative ? hover.tr.label : hover.tr.id}</b> · {hover.tr.classification === 'unknown' ? hover.tr.category : hover.tr.classification} · {hover.tr.status}
            {hover.tr.reported && hover.tr.reported.affiliation !== 'friend' && <span style={{ color: 'var(--red)' }}> · reported {hover.tr.reported.affiliation}</span>}
          </div>
        )}
        <div className="scope-legend">
          <span>
            <i className="lg friend" /> friend
          </span>
          <span>
            <i className="lg unknown" /> unknown
          </span>
          <span>
            <i className="lg hostile" /> hostile
          </span>
          <span>
            <i className="lg dashed" /> not currently observed
          </span>
        </div>
      </div>
    </section>
  );
}

function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * p;
}
