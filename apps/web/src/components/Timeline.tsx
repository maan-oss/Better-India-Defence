import { useCallback, useEffect, useRef, useState } from 'react';
import { useTime, RATES } from '../state/time';
import { useData } from '../state/data';
import { useWorld } from '../state/world';
import { Icon } from './Icons';
import { hm, hms } from '../lib/format';
import { alpha, P, PRIORITY_COLOR } from '../lib/palette';

// Observation density is a measure, not a status: muted categorical tones from the cool family.
const KIND_COLORS: Record<string, string> = {
  track: alpha(P.text1, 0.5),
  media: alpha(P.accent2, 0.42),
  position: alpha(P.reconstructed, 0.45),
  rf: alpha(P.inferred, 0.55),
  infrastructure: alpha(P.off, 0.4),
  spatial: alpha(P.text0, 0.9),
  imagery: alpha(P.text0, 0.9),
};

interface Hit {
  kind: 'alert' | 'change' | 'incident' | 'imagery' | 'lidar' | 'outage';
  id: string;
  t: number;
  label: string;
}

/**
 * The time engine's control surface. Draws observation density, events and sensor outages over the
 * recorded period; scrubbing seeks the whole world, and the live edge is always explicit.
 */
export function Timeline() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hits = useRef<{ x: number; y: number; hit: Hit }[]>([]);
  const [tip, setTip] = useState<{ x: number; text: string } | null>(null);
  const mode = useWorld((s) => s.mode);
  const diff = useWorld((s) => s.diff);
  const incidentId = useWorld((s) => s.incidentId);
  const rate = useTime((s) => s.rate);
  const tmode = useTime((s) => s.mode);
  const playing = useTime((s) => s.playing);
  const direction = useTime((s) => s.direction);
  const [view, setView] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef<null | 'seek' | 'A' | 'B'>(null);

  // Default view: entire recorded range up to the live edge.
  const currentView = useCallback(() => {
    const t = useTime.getState();
    const edge = t.currentLiveEdge();
    if (view) return { from: view.from, to: Math.min(view.to, edge + 60_000) > view.from ? view.to : edge };
    const from = t.rangeFrom || edge - 2 * 3600_000;
    return { from, to: edge + (edge - from) * 0.02 };
  }, [view]);

  // Load timeline aggregates for the view.
  useEffect(() => {
    const load = () => {
      const v = currentView();
      void useData.getState().loadTimeline(v.from, v.to).catch(() => undefined);
    };
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [currentView]);

  const xOf = (t: number, w: number, v: { from: number; to: number }) => ((t - v.from) / (v.to - v.from)) * w;
  const tOf = (x: number, w: number, v: { from: number; to: number }) => v.from + (x / w) * (v.to - v.from);

  // Render loop (canvas only; no React re-render per frame).
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvasRef.current;
      const wrap = wrapRef.current;
      if (!c || !wrap) return;
      const dpr = Math.min(2, window.devicePixelRatio);
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      if (c.width !== W * dpr || c.height !== H * dpr) {
        c.width = W * dpr;
        c.height = H * dpr;
      }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const v = currentView();
      const time = useTime.getState();
      const edge = time.currentLiveEdge();
      const data = useData.getState().timeline;
      const lanes = { density: [4, 34], events: [40, 62], outages: [66, H - 18] } as const;
      hits.current = [];
      // future (no data yet)
      const xe = xOf(edge, W, v);
      if (xe < W) {
        g.fillStyle = alpha(P.text0, 0.015);
        g.fillRect(xe, 0, W - xe, H - 16);
        g.strokeStyle = alpha(P.text0, 0.04);
        for (let x = xe; x < W; x += 6) {
          g.beginPath();
          g.moveTo(x, 0);
          g.lineTo(x + 10, H - 16);
          g.stroke();
        }
      }
      // incident spans
      if (data)
        for (const inc of data.incidents) {
          const x0 = xOf(inc.tStart, W, v);
          const x1 = xOf(inc.tEnd, W, v);
          g.fillStyle = inc.id === incidentId ? alpha(P.serious, 0.14) : alpha(P.serious, 0.06);
          g.fillRect(x0, 0, Math.max(2, x1 - x0), H - 16);
          g.fillStyle = alpha(P.serious, 0.85);
          g.font = '10px IBM Plex Mono';
          g.fillText(inc.code, x0 + 3, H - 20);
          hits.current.push({ x: x0 + 20, y: H - 24, hit: { kind: 'incident', id: inc.id, t: inc.tStart, label: `${inc.code} — ${inc.title}` } });
        }
      // density histogram (stacked)
      if (data) {
        const n = Math.ceil((data.to - data.from) / data.bucketMs);
        let max = 1;
        const tot = new Array<number>(n).fill(0);
        for (const arr of Object.values(data.observations)) arr.forEach((val, i) => (tot[i]! += val));
        for (const val of tot) max = Math.max(max, val);
        const order = ['track', 'position', 'media', 'rf', 'infrastructure'];
        const acc = new Array<number>(n).fill(0);
        for (const k of order) {
          const arr = data.observations[k];
          if (!arr) continue;
          g.fillStyle = KIND_COLORS[k] ?? alpha(P.text0, 0.3);
          for (let i = 0; i < n; i++) {
            const val = arr[i] ?? 0;
            if (!val) continue;
            const x = xOf(data.from + i * data.bucketMs, W, v);
            const bw = Math.max(1, xOf(data.from + (i + 1) * data.bucketMs, W, v) - x - 0.5);
            const h0 = (acc[i]! / max) * (lanes.density[1] - lanes.density[0]);
            const h1 = (val / max) * (lanes.density[1] - lanes.density[0]);
            g.fillRect(x, lanes.density[1] - h0 - h1, bw, h1);
            acc[i]! += val;
          }
        }
        // events lane
        for (const ch of data.changes) {
          if (ch.kind === 'sensor_restored') continue;
          const x = xOf(ch.t, W, v);
          const y = 48;
          g.fillStyle = ch.kind.startsWith('sensor') ? P.critical : P.caution;
          g.beginPath();
          g.moveTo(x, y - 4);
          g.lineTo(x + 4, y);
          g.lineTo(x, y + 4);
          g.lineTo(x - 4, y);
          g.closePath();
          g.fill();
          hits.current.push({ x, y, hit: { kind: 'change', id: ch.id, t: ch.t, label: ch.title } });
        }
        for (const a of data.alerts) {
          const x = xOf(a.t, W, v);
          g.fillStyle = PRIORITY_COLOR[a.priority] ?? P.off;
          g.fillRect(x - 1, 54, 2, 9);
          hits.current.push({ x, y: 58, hit: { kind: 'alert', id: a.id, t: a.t, label: `${a.priority.toUpperCase()} · ${a.title}` } });
        }
        for (const im of data.imagery) {
          const x = xOf(im.t, W, v);
          g.strokeStyle = alpha(P.text0, 0.75);
          g.strokeRect(x - 3, 38, 6, 6);
          hits.current.push({ x, y: 41, hit: { kind: 'imagery', id: im.id, t: im.t, label: `Overhead imagery acquired ${hms(im.t)}Z` } });
        }
        for (const l of data.lidar) {
          const x = xOf(l.t, W, v);
          g.fillStyle = alpha(P.reconstructed, 0.8);
          g.beginPath();
          g.arc(x, 41, 2, 0, Math.PI * 2);
          g.fill();
          hits.current.push({ x, y: 41, hit: { kind: 'lidar', id: l.id, t: l.t, label: `LiDAR scan ${l.sensorId} ${hms(l.t)}Z` } });
        }
        // outages lane
        const ids = [...new Set(data.outages.map((o) => o.sensorId))];
        const lh = Math.max(3, Math.min(6, (lanes.outages[1] - lanes.outages[0]) / Math.max(1, ids.length)));
        data.outages.forEach((o) => {
          const row = ids.indexOf(o.sensorId);
          const x0 = Math.max(0, xOf(o.from, W, v));
          const x1 = Math.min(W, xOf(o.to ?? edge, W, v));
          const y = lanes.outages[0] + row * (lh + 1);
          if (y > lanes.outages[1]) return;
          g.fillStyle = alpha(P.critical, 0.55);
          g.fillRect(x0, y, Math.max(1, x1 - x0), lh);
          hits.current.push({ x: (x0 + x1) / 2, y: y + lh / 2, hit: { kind: 'outage', id: o.sensorId, t: o.from, label: `${o.sensorId} ${o.status} ${hms(o.from)}–${o.to ? hms(o.to) : 'ongoing'}` } });
        });
      }
      // axis
      g.fillStyle = P.text3;
      g.font = '10px IBM Plex Mono';
      const span = v.to - v.from;
      const steps = [60_000, 300_000, 600_000, 900_000, 1800_000, 3600_000, 7200_000];
      const step = steps.find((s) => (s / span) * W > 70) ?? 7200_000;
      for (let tt = Math.ceil(v.from / step) * step; tt < v.to; tt += step) {
        const x = xOf(tt, W, v);
        g.fillRect(x, H - 16, 1, 4);
        g.fillText(hm(tt), x + 3, H - 5);
      }
      // DIFF handles
      const d = useWorld.getState().diff;
      if (mode === 'DIFF' && d) {
        for (const [k, tt, col] of [['A', d.a, P.accent], ['B', d.b, P.reconstructed]] as const) {
          const x = xOf(tt, W, v);
          g.fillStyle = col;
          g.fillRect(x - 1, 0, 2, H - 16);
          g.fillRect(x - 7, 0, 14, 13);
          g.fillStyle = P.bg0;
          g.font = '600 10px IBM Plex Sans';
          g.fillText(k, x - 3, 10);
        }
        const xa = xOf(Math.min(d.a, d.b), W, v);
        const xb = xOf(Math.max(d.a, d.b), W, v);
        g.fillStyle = alpha(P.accent, 0.06);
        g.fillRect(xa, 0, xb - xa, H - 16);
      }
      // live edge + playhead
      g.fillStyle = alpha(P.normal, 0.85);
      g.fillRect(xe - 0.5, 0, 1, H - 16);
      g.font = '600 9.5px IBM Plex Sans';
      g.fillText('NOW', xe + 3, 10);
      const xp = xOf(time.mode === 'live' ? edge : time.t, W, v);
      g.fillStyle = P.text0;
      g.fillRect(xp - 1, 0, 2, H - 16);
      g.beginPath();
      g.moveTo(xp - 5, 0);
      g.lineTo(xp + 5, 0);
      g.lineTo(xp, 6);
      g.fill();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [currentView, mode, incidentId, diff]);

  const handleAt = (clientX: number): { x: number; t: number; W: number } => {
    const r = wrapRef.current!.getBoundingClientRect();
    const x = clientX - r.left;
    return { x, t: tOf(x, r.width, currentView()), W: r.width };
  };

  const onDown = (e: React.PointerEvent) => {
    const { x, t } = handleAt(e.clientX);
    const r = wrapRef.current!.getBoundingClientRect();
    const y = e.clientY - r.top;
    const d = useWorld.getState().diff;
    if (mode === 'DIFF' && d) {
      const v = currentView();
      const xa = xOf(d.a, r.width, v);
      const xb = xOf(d.b, r.width, v);
      if (Math.abs(x - xa) < 8) dragRef.current = 'A';
      else if (Math.abs(x - xb) < 8) dragRef.current = 'B';
    }
    if (!dragRef.current) {
      const near = hits.current.filter((h) => Math.abs(h.x - x) < 5 && Math.abs(h.y - y) < 8)[0];
      if (near && near.hit.kind !== 'outage') {
        const w = useWorld.getState();
        if (near.hit.kind === 'alert') w.select({ kind: 'alert', id: near.hit.id });
        if (near.hit.kind === 'change') w.select({ kind: 'change', id: near.hit.id });
        if (near.hit.kind === 'incident') {
          w.setIncident(near.hit.id);
          w.setMode('INCIDENT');
        }
        useTime.getState().seek(near.hit.t);
        return;
      }
      dragRef.current = 'seek';
      useTime.getState().seek(t);
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const { x, t } = handleAt(e.clientX);
    const r = wrapRef.current!.getBoundingClientRect();
    const y = e.clientY - r.top;
    if (dragRef.current === 'seek') useTime.getState().seek(t);
    else if (dragRef.current === 'A' || dragRef.current === 'B') {
      const d = useWorld.getState().diff!;
      const edge = useTime.getState().currentLiveEdge();
      const tt = Math.min(edge, Math.max(useTime.getState().rangeFrom, t));
      useWorld.getState().setDiff(dragRef.current === 'A' ? { a: tt, b: d.b } : { a: d.a, b: tt });
    }
    const near = hits.current.filter((h) => Math.abs(h.x - x) < 5 && Math.abs(h.y - y) < 8)[0];
    setTip(near ? { x, text: `${hms(near.hit.t)}Z · ${near.hit.label}` } : { x, text: `${hms(t)}Z` });
  };
  const onUp = () => {
    dragRef.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    const { t, W } = handleAt(e.clientX);
    void W;
    const v = currentView();
    const span = v.to - v.from;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dt = (e.deltaX || e.deltaY) * span * 0.001;
      setView({ from: v.from + dt, to: v.to + dt });
      return;
    }
    const k = Math.exp(e.deltaY * 0.0015);
    const ns = Math.max(60_000, Math.min(48 * 3600_000, span * k));
    const f = (t - v.from) / span;
    setView({ from: t - f * ns, to: t + (1 - f) * ns });
  };

  const time = useTime.getState();
  const preset = (ms: number | null) => {
    if (ms === null) return setView(null);
    const center = time.mode === 'live' ? time.currentLiveEdge() : time.t;
    const edge = time.currentLiveEdge();
    const to = Math.min(edge + ms * 0.05, center + ms / 2);
    setView({ from: to - ms, to });
  };

  return (
    <div className="timeline">
      <div className="tl-controls">
        <button className="btn icon small ghost" title="Step back (frame)" aria-label="Step back" onClick={(e) => time.step(e.shiftKey ? -10 : -1)}>
          <Icon.StepB />
        </button>
        <button className={`btn icon small ${playing && tmode === 'replay' && direction < 0 ? 'on' : 'ghost'}`} title="Play in reverse" aria-label="Play reverse" onClick={() => time.setDirection(-1)}>
          <Icon.Reverse />
        </button>
        <button className="btn icon small" title="Play / pause (Space)" aria-label={playing && tmode === 'replay' ? 'Pause' : 'Play'} onClick={() => (tmode === 'replay' && !playing ? (time.setDirection(1), time.setPlaying(true)) : time.togglePlay())}>
          {tmode === 'live' || (playing && direction > 0) ? <Icon.Pause /> : <Icon.Play />}
        </button>
        <button className="btn icon small ghost" title="Step forward (frame)" aria-label="Step forward" onClick={(e) => time.step(e.shiftKey ? 10 : 1)}>
          <Icon.StepF />
        </button>
        <div className="seg speed" role="group" aria-label="Playback speed">
          {RATES.map((r) => (
            <button key={r} className={rate === r ? 'on' : ''} onClick={() => time.setRate(r)}>
              ×{r}
            </button>
          ))}
        </div>
        <button className={`btn small ${tmode === 'live' ? 'on' : ''}`} onClick={() => time.goLive()} title="Return to live">
          <span className={`status-dot ${tmode === 'live' ? 'ok' : 'degraded'}`} /> LIVE
        </button>
        <div className="spacer" />
        {mode === 'DIFF' && (
          <span className="row muted" style={{ fontSize: 11.5 }}>
            Drag <b style={{ color: 'var(--accent)' }}>A</b> and <b style={{ color: 'var(--reconstructed)' }}>B</b> handles to choose the comparison
          </span>
        )}
        <div className="seg" role="group" aria-label="Zoom">
          {(
            [
              ['15m', 15 * 60_000],
              ['1h', 3600_000],
              ['3h', 3 * 3600_000],
              ['All', null],
            ] as const
          ).map(([l, ms]) => (
            <button key={l} onClick={() => preset(ms)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div ref={wrapRef} className="tl-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setTip(null)} onWheel={onWheel} role="slider" aria-label="Timeline" aria-valuenow={Math.round(time.t)} tabIndex={0}>
        <canvas ref={canvasRef} />
        {tip && (
          <div className="tl-tip glass mono" style={{ left: Math.min(tip.x + 10, (wrapRef.current?.clientWidth ?? 600) - 260) }}>
            {tip.text}
          </div>
        )}
      </div>
    </div>
  );
}
