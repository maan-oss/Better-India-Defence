import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useWorld } from '../state/world';
import { get } from '../api/client';
import type { SensorListItem } from '../api/types';
import { ErrorNote, Loading, ObservationViewer, StateChip, useAsync } from '../components/common';
import { CameraFeed } from '../components/CameraFeed';
import { useTime } from '../state/time';
import { useSession } from '../state/session';
import { ago, hms } from '../lib/format';

interface SensorDetail {
  definition: SensorListItem['definition'];
  status: SensorListItem['status'];
  events: { t: number; status: string; previous: string | null; message: string | null }[];
  recent: { id: string; t: number; kind: string; source_kind: string; state: string; quality: Record<string, unknown> }[];
  perMinute: { b: number; n: number }[];
  coveragePatches: number | null;
}

/** SENSORS — fleet health, configuration, coverage and diagnostics. */
export function Sensors() {
  const { id } = useParams();
  const nav = useNavigate();
  const [filter, setFilter] = useState('');
  const { data, error, reload } = useAsync((s) => get<SensorListItem[]>('/api/sensors', s), []);
  const rows = useMemo(() => (data ?? []).filter((r) => !filter || `${r.definition.id} ${r.definition.name} ${r.definition.kind}`.toLowerCase().includes(filter.toLowerCase())), [data, filter]);
  const counts = useMemo(() => {
    const c = { ok: 0, degraded: 0, down: 0 };
    for (const r of data ?? []) {
      const s = r.status?.status ?? 'silent';
      if (s === 'ok') c.ok++;
      else if (s === 'degraded') c.degraded++;
      else if (r.definition.kind !== 'satellite') c.down++;
    }
    return c;
  }, [data]);
  return (
    <div className="page">
      <div className="page-h">
        <h1>Sensors</h1>
        <span className="sub">Status is derived from observed traffic, not only self-reported health.</span>
        <div className="spacer" />
        <input className="input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn" onClick={reload}>
          Refresh
        </button>
      </div>
      <div className="cards">
        <div className="stat">
          <div className="v">{data?.length ?? '—'}</div>
          <div className="l">Registered sensors</div>
        </div>
        <div className="stat">
          <div className="v">{counts.ok}</div>
          <div className="l">Reporting normally</div>
        </div>
        <div className="stat">
          <div className="v" style={{ color: counts.degraded ? 'var(--st-caution)' : undefined }}>
            {counts.degraded}
          </div>
          <div className="l">Degraded</div>
        </div>
        <div className="stat">
          <div className="v" style={{ color: counts.down ? 'var(--red)' : undefined }}>
            {counts.down}
          </div>
          <div className="l">Silent / offline</div>
        </div>
      </div>
      <div className="page-body split">
        <div className="scroll">
          {error && <ErrorNote error={error} />}
          {!data && !error && <Loading />}
          <table className="table">
            <thead>
              <tr>
                <th>Sensor</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Last traffic</th>
                <th>Obs/10 min</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.definition.id} className="click" style={r.definition.id === id ? { background: 'var(--bg-3)' } : undefined} onClick={() => nav(`/sensors/${r.definition.id}`)}>
                  <td>
                    <span className="mono">{r.definition.id}</span> <span className="muted">{r.definition.name}</span>
                  </td>
                  <td className="muted">{r.definition.kind}</td>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <span className={`status-dot ${r.status?.status ?? 'silent'}`} />
                      {r.status?.status ?? '—'}
                    </span>
                  </td>
                  <td className="mono muted">{r.status?.lastSeen ? hms(r.status.lastSeen) : '—'}</td>
                  <td className="mono">{r.observationsLast10Min}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="scroll">{id ? <SensorDetailView id={id} /> : <SensorMap rows={data ?? []} onPick={(sid) => nav(`/sensors/${sid}`)} />}</div>
      </div>
    </div>
  );
}

function SensorDetailView({ id }: { id: string }) {
  const { data, error } = useAsync((s) => get<SensorDetail>(`/api/sensors/${id}`, s), [id]);
  const [obs, setObs] = useState<string | null>(null);
  const can = useSession((s) => s.can);
  const t = useTime((s) => Math.floor((s.mode === 'live' ? s.currentLiveEdge() : s.t) / 2000) * 2000);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const d = data.definition;
  const max = Math.max(1, ...data.perMinute.map((p) => p.n));
  return (
    <div className="reveal">
      <div className="section">
        <div className="upper muted">
          {d.kind} · segment {d.segment}
        </div>
        <h2 style={{ fontWeight: 500, fontSize: 17, margin: '4px 0' }}>
          {d.id} — {d.name}
        </h2>
        <div className="row">
          <span className={`status-dot ${data.status?.status ?? 'silent'}`} /> {data.status?.status ?? 'unknown'} · last traffic {ago(data.status?.lastSeen, Date.now())}
          {data.status?.message && <span className="muted"> · {data.status.message}</span>}
        </div>
      </div>
      {(d.kind === 'camera' || d.kind === 'drone') && <CameraFeed sensorId={d.id} t={t} live={useTime.getState().mode === 'live'} />}
      <div className="section">
        <h4>Traffic, last 60 minutes</h4>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 60 }}>
          {Array.from({ length: 60 }, (_, i) => {
            const v = data.perMinute.find((p) => p.b === i)?.n ?? 0;
            return <div key={i} title={`${v}`} style={{ flex: 1, height: `${(v / max) * 100}%`, minHeight: v ? 2 : 0, background: v ? 'var(--text-2)' : 'transparent', borderBottom: v ? 'none' : '1px solid var(--red)' }} />;
          })}
        </div>
        <div className="row dim mono" style={{ fontSize: 10.5 }}>
          <span>−60 min</span>
          <span className="spacer" />
          <span>now</span>
        </div>
      </div>
      {data.coveragePatches !== null && (
        <div className="section">
          <h4>Coverage</h4>
          Calibrated view covers <b>{data.coveragePatches}</b> surface patches (walls, roofs, ground cells) against baseline geometry.
        </div>
      )}
      <div className="section">
        <h4>Status history</h4>
        {data.events.length === 0 && <div className="muted">No transitions recorded.</div>}
        {data.events.map((e, i) => (
          <div key={i} className="row mono" style={{ fontSize: 12, padding: '2px 0' }}>
            <span className="muted">{hms(e.t)}Z</span>
            <span>
              {e.previous ?? '—'} → {e.status}
            </span>
            <span className="muted">{e.message}</span>
          </div>
        ))}
      </div>
      <div className="section">
        <h4>Recent observations</h4>
        {data.recent.slice(0, 30).map((o) => (
          <div key={o.id} className="row" style={{ fontSize: 12, padding: '2px 0', cursor: 'pointer' }} onClick={() => setObs(o.id)}>
            <span className="mono muted">{hms(o.t)}</span>
            <span className="mono">{o.source_kind}</span>
            <StateChip state={o.state} />
            <span className="muted mono">
              {Object.entries(o.quality)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(' ')}
            </span>
          </div>
        ))}
      </div>
      <div className="section">
        <h4>Configuration</h4>
        <pre className="mono scroll" style={{ background: 'var(--bg-0)', padding: 10, border: '1px solid var(--line)', maxHeight: 260 }}>
          {JSON.stringify(d, null, 2)}
        </pre>
      </div>
      {can('system.view') && <DeadLetters sensorId={d.id} />}
      {obs && <ObservationViewer id={obs} onClose={() => setObs(null)} />}
    </div>
  );
}

function DeadLetters({ sensorId }: { sensorId: string }) {
  const { data } = useAsync((s) => get<{ id: number; received_at: number; reason: string; sensor_id: string | null; raw: string }[]>('/api/ingest/dead-letters', s), [sensorId]);
  const rows = (data ?? []).filter((r) => r.sensor_id === sensorId);
  return (
    <div className="section">
      <h4>Rejected messages for this sensor ({rows.length})</h4>
      {rows.slice(0, 20).map((r) => (
        <div key={r.id} className="col" style={{ padding: '4px 0', borderTop: '1px solid var(--line)' }}>
          <span className="mono muted">
            {hms(r.received_at)} · {r.reason}
          </span>
          <span className="mono dim ellipsis">{r.raw}</span>
        </div>
      ))}
    </div>
  );
}

const KIND_GLYPH: Record<string, string> = { camera: 'M-5 -3h7l3 -2v10l-3 -2h-7z', radar: 'M-6 4a6 6 0 0 1 12 0M0 4V-5', rf: 'M-5 3a5 5 0 0 1 0-6M5 3a5 5 0 0 0 0-6M0 -1v6', lidar: 'M-5 -5h10v10h-10z', drone: 'M-6 0h12M0 -6v12', fence: 'M-6 -4v8M0 -4v8M6 -4v8M-7 0h14', bms: 'M-5 -5h10v10h-10zM-5 0h10', gps: 'M0 -6l5 12h-10z', external: 'M-6 0h12M3 -3l3 3-3 3' };

/** Site plan with every positioned sensor. Healthy sensors are drawn neutral (ISA-101): only a problem gets colour. */
function SensorMap({ rows, onPick }: { rows: SensorListItem[]; onPick: (id: string) => void }) {
  const facility = useWorld((s) => s.facility);
  const [hover, setHover] = useState<string | null>(null);
  if (!facility) return null;
  const H = facility.perimeterHalfM * 1.2;
  const placed = rows.filter((r) => 'position' in r.definition) as (SensorListItem & { definition: { position: { x: number; y: number } } })[];
  const color = (st: string | undefined) => (st === 'ok' ? 'var(--text-1)' : st === 'degraded' ? 'var(--st-caution)' : 'var(--st-critical)');
  return (
    <div className="sensor-map reveal">
      <div className="section">
        <h4>Sensor estate</h4>
        <div className="muted" style={{ fontSize: 12 }}>
          {placed.length} positioned sensors. Select one for diagnostics; feeds without a fixed position (GPS gateways, interop, satellite) are listed on the left.
        </div>
      </div>
      <svg viewBox={`${-H} ${-H} ${2 * H} ${2 * H}`} className="smap" role="img" aria-label="Sensor map">
        <g transform="scale(1,-1)">
          {facility.zones.map((z) => (
            <polygon key={z.id} points={z.polygon.map((p) => `${p.x},${p.y}`).join(' ')} fill={z.restricted ? 'rgba(169,187,207,0.06)' : 'rgba(169,187,207,0.025)'} stroke={z.restricted ? 'rgba(169,187,207,0.45)' : 'rgba(169,187,207,0.15)'} strokeDasharray={z.restricted ? undefined : `${H / 120} ${H / 160}`} strokeWidth={H / 400} />
          ))}
          {facility.buildings.map((b) => (
            <rect key={b.id} x={b.center.x - b.width / 2} y={b.center.y - b.depth / 2} width={b.width} height={b.depth} transform={`rotate(${b.yawDeg} ${b.center.x} ${b.center.y})`} fill="rgba(169,187,207,0.12)" />
          ))}
          {facility.fence.map((f) => (
            <line key={f.id} x1={f.a.x} y1={f.a.y} x2={f.b.x} y2={f.b.y} stroke="rgba(143,162,184,0.7)" strokeWidth={H / 300} strokeDasharray={`${H / 60} ${H / 90}`} />
          ))}
          {placed.map((r) => {
            const d = r.definition as SensorListItem['definition'] & { position: { x: number; y: number }; rangeM?: number; headingDeg?: number; hfovDeg?: number };
            const st = r.status?.status;
            const sel = hover === d.id;
            const s = H / 70;
            return (
              <g key={d.id} transform={`translate(${d.position.x} ${d.position.y})`} onMouseEnter={() => setHover(d.id)} onMouseLeave={() => setHover(null)} onClick={() => onPick(d.id)} style={{ cursor: 'pointer' }}>
                {d.kind === 'camera' && d.headingDeg !== undefined && d.hfovDeg !== undefined && (
                  <path d={wedge(d.headingDeg, d.hfovDeg, Math.min(d.rangeM ?? 300, H / 3))} fill={sel ? 'rgba(77,172,255,0.2)' : 'rgba(169,187,207,0.05)'} stroke="none" />
                )}
                {(d.kind === 'radar' || d.kind === 'rf') && d.rangeM && <circle r={Math.min(d.rangeM, H * 2)} fill="none" stroke={color(st)} strokeOpacity={sel ? 0.5 : 0.12} strokeWidth={H / 500} strokeDasharray={`${H / 80} ${H / 80}`} />}
                <circle r={s * 1.25} fill="var(--bg-1)" stroke={color(st)} strokeWidth={s / 4} />
                <path d={KIND_GLYPH[d.kind] ?? 'M-3 0h6'} transform={`scale(${s / 7}, ${-s / 7})`} fill="none" stroke={color(st)} strokeWidth={1.4} />
                {(sel || st !== 'ok') && (
                  <text transform={`scale(1,-1)`} x={s * 1.8} y={s * 0.5} fontSize={s * 1.6} fill="var(--text-0)" fontFamily="IBM Plex Mono, monospace">
                    {d.id}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="row smap-legend">
        <span>
          <i style={{ background: 'var(--text-1)' }} /> reporting
        </span>
        <span>
          <i style={{ background: 'var(--st-caution)' }} /> degraded
        </span>
        <span>
          <i style={{ background: 'var(--red)' }} /> silent / fault
        </span>
      </div>
    </div>
  );
}

function wedge(headingDeg: number, fovDeg: number, r: number): string {
  const a0 = ((90 - headingDeg - fovDeg / 2) * Math.PI) / 180;
  const a1 = ((90 - headingDeg + fovDeg / 2) * Math.PI) / 180;
  return `M0 0 L${Math.cos(a0) * r} ${Math.sin(a0) * r} A${r} ${r} 0 0 1 ${Math.cos(a1) * r} ${Math.sin(a1) * r} Z`;
}
