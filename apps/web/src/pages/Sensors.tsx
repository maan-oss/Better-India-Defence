import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Cctv, Database, MapPin } from 'lucide-react';
import { useWorld } from '../state/world';
import { get } from '../api/client';
import type { SensorListItem } from '../api/types';
import { ErrorNote, Loading, ObservationViewer, StateChip, useAsync } from '../components/common';
import { CameraFeed } from '../components/CameraFeed';
import { useTime } from '../state/time';
import { useSession } from '../state/session';
import { ago, hms } from '../lib/format';
import { Empty } from '../brand/Boot';
import { ButtonGroup, BrushChart, Button, JsonViewer, MetricCard, SearchField, SortableDataTable, Timeline as ArcTimeline, WaffleChart } from '../components/kit';

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
  const rows = useMemo(
    () =>
      (data ?? [])
        .filter((r) => !filter || `${r.definition.id} ${r.definition.name} ${r.definition.kind}`.toLowerCase().includes(filter.toLowerCase()))
        .map((r) => ({ id: r.definition.id, name: r.definition.name, kind: r.definition.kind, status: r.status?.status ?? 'unreported', lastSeen: r.status?.lastSeen ?? 0, obs: r.observationsLast10Min })),
    [data, filter],
  );
  const counts = useMemo(() => {
    const c = { ok: 0, degraded: 0, down: 0, unreported: 0 };
    for (const r of data ?? []) {
      const s = r.status?.status;
      if (s === 'ok') c.ok++;
      else if (s === 'degraded') c.degraded++;
      else if (s) c.down++;
      else c.unreported++;
    }
    return c;
  }, [data]);
  const total = data?.length ?? 0;
  return (
    <div className="page">
      <div className="page-h">
        <h1>Sensors</h1>
        <span className="sub">Status is derived from observed traffic, not only self-reported health.</span>
        <div className="spacer" />
        <div className="sn-search">
          <SearchField label="Find sensor" placeholder="ID, name or kind" value={filter} onValueChange={setFilter} />
        </div>
        <Button variant="secondary" onClick={reload}>
          Refresh
        </Button>
      </div>
      {total > 0 && (
        <div className="sn-summary metric-strip">
          <MetricCard label="Registered" value={total} context="sensors in the site configuration" />
          <MetricCard label="Reporting" value={counts.ok} context="traffic within expected cadence" />
          <MetricCard label="Degraded" value={counts.degraded} context="late, sparse or self-reported fault" />
          <MetricCard label="Silent" value={counts.down} context={counts.unreported ? `plus ${counts.unreported} never reported` : 'no traffic past the silence limit'} />
          <div className="sn-waffle">
            <WaffleChart
              label="Sensor estate by status"
              unit="sensors"
              rows={4}
              columns={20}
              accentKey={null}
              data={[
                { key: 'ok', label: 'Reporting', value: counts.ok, color: 'var(--text-2)' },
                { key: 'degraded', label: 'Degraded', value: counts.degraded, color: 'var(--st-caution)' },
                { key: 'down', label: 'Silent', value: counts.down, color: 'var(--st-critical)' },
                { key: 'unreported', label: 'Never reported', value: counts.unreported, color: 'var(--line-3)' },
              ].filter((c) => c.value > 0)}
            />
          </div>
        </div>
      )}
      <div className="page-body split">
        <div className="scroll">
          {error && <ErrorNote error={error} />}
          {!data && !error && <Loading />}
          {data && total === 0 && <Empty art="sensors" title="No sensors registered" description="Add sensors in Site configuration. Each one appears here once its first message arrives." />}
          {total > 0 && (
            <div className="sn-table">
              <SortableDataTable
                caption="Sensors"
                rowKey="id"
                itemName={{ one: 'sensor', other: 'sensors' }}
                emptyMessage="No sensor matches the search"
                defaultSort={{ key: 'status', direction: 'asc' }}
                rows={rows}
                columns={[
                  {
                    key: 'id',
                    label: 'Sensor',
                    sortable: true,
                    width: 84,
                    render: (v) => (
                      <button className="obs-link" aria-current={v === id ? 'true' : undefined} onClick={() => nav(`/sensors/${String(v)}`)}>
                        {String(v)}
                      </button>
                    ),
                  },
                  { key: 'name', label: 'Name', sortable: true, render: (v) => <span className="muted">{String(v)}</span> },
                  { key: 'kind', label: 'Kind', sortable: true, width: 90 },
                  {
                    key: 'status',
                    label: 'Status',
                    sortable: true,
                    width: 128,
                    render: (v) => (
                      <span className="row" style={{ gap: 6 }}>
                        <span className={`status-dot ${v === 'unreported' ? 'silent' : String(v)}`} />
                        {v === 'unreported' ? 'never reported' : String(v)}
                      </span>
                    ),
                  },
                  { key: 'lastSeen', label: 'Last traffic', sortable: true, width: 110, render: (v) => <span className="mono muted">{v ? `${hms(Number(v))}Z` : '—'}</span> },
                  { key: 'obs', label: 'Obs / 10 min', sortable: true, numeric: true, width: 104 },
                ]}
              />
            </div>
          )}
        </div>
        <div className="scroll">{id ? <SensorDetailView id={id} /> : <SensorMap rows={data ?? []} onPick={(sid) => nav(`/sensors/${sid}`)} />}</div>
      </div>
    </div>
  );
}

const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

function SensorDetailView({ id }: { id: string }) {
  const nav = useNavigate();
  const { data, error } = useAsync((s) => get<SensorDetail>(`/api/sensors/${id}`, s), [id]);
  const [obs, setObs] = useState<string | null>(null);
  const can = useSession((s) => s.can);
  const t = useTime((s) => Math.floor((s.mode === 'live' ? s.currentLiveEdge() : s.t) / 2000) * 2000);
  const traffic = useMemo(() => {
    if (!data) return [];
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    return Array.from({ length: 60 }, (_, i) => ({ date: now - (59 - i) * 60_000, value: data.perMinute.find((p) => p.b === i)?.n ?? 0 }));
  }, [data]);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const d = data.definition;
  const gaps = traffic.filter((p) => p.value === 0).length;
  return (
    <div className="reveal sn-detail">
      <div className="section">
        <div className="upper muted">
          {d.kind} · segment {d.segment}
        </div>
        <h2 style={{ fontWeight: 600, fontSize: 18, margin: '4px 0', letterSpacing: '-0.01em' }}>
          <span className="mono">{d.id}</span> <span className="muted">{d.name}</span>
        </h2>
        <div className="row">
          <span className={`status-dot ${data.status?.status ?? 'silent'}`} /> {data.status?.status ?? 'never reported'} · last traffic {ago(data.status?.lastSeen, Date.now())}
          {data.status?.message && <span className="muted"> · {data.status.message}</span>}
        </div>
        <div style={{ marginTop: 12 }}>
          <ButtonGroup
            label={`${d.id} actions`}
            size="sm"
            items={[
              ...('position' in d && d.position ? [{ id: 'map', label: 'Show on map', icon: <MapPin size={14} />, onSelect: () => (nav('/operations'), useWorld.getState().select({ kind: 'sensor', id: d.id }), useWorld.getState().flyTo((d as { position: { x: number; y: number; z?: number } }).position as { x: number; y: number; z: number }, 300)) }] : []),
              { id: 'evidence', label: 'Its observations', icon: <Database size={14} />, onSelect: () => nav(`/evidence?sensor=${encodeURIComponent(d.id)}`) },
              ...(d.kind === 'camera' ? [{ id: 'wall', label: 'Camera wall', icon: <Cctv size={14} />, onSelect: () => nav('/cameras') }] : []),
            ]}
          />
        </div>
      </div>
      {(d.kind === 'camera' || d.kind === 'drone') && <CameraFeed sensorId={d.id} t={t} live={useTime.getState().mode === 'live'} />}
      <div className="section">
        <h4>Traffic, last 60 minutes</h4>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {gaps === 0 ? 'Messages arrived in every minute.' : gaps === 60 ? 'No messages in the last hour.' : `${gaps} of 60 minutes without a message.`} Drag the strip below to look closer.
        </div>
        <BrushChart data={traffic} label={`Messages per minute from ${d.id}`} unit="msg" minSpan={5 * 60_000} height={150} overviewHeight={36} formatDate={hhmm} emptyLabel="No traffic" />
      </div>
      {data.coveragePatches !== null && (
        <div className="section">
          <h4>Coverage</h4>
          Calibrated view covers <b>{data.coveragePatches}</b> surface patches (walls, roofs, ground cells) against baseline geometry.
        </div>
      )}
      <div className="section">
        <h4>Status history</h4>
        {data.events.length === 0 ? (
          <div className="muted">No transitions recorded.</div>
        ) : (
          <ArcTimeline
            label={`Status history of ${d.id}`}
            now={Date.now()}
            maxHeight={260}
            events={data.events.map((e, i) => ({ id: `${e.t}-${i}`, at: e.t, title: `${e.previous ?? 'unknown'} → ${e.status}`, meta: e.message ?? undefined, tone: e.status === 'ok' ? 'success' : e.status === 'degraded' ? 'neutral' : 'danger' }))}
          />
        )}
      </div>
      <div className="section">
        <h4>Recent observations</h4>
        {data.recent.length === 0 && <div className="muted">None in the retention window.</div>}
        {data.recent.slice(0, 30).map((o) => (
          <div key={o.id} className="row" style={{ fontSize: 12, padding: '3px 0' }}>
            <button className="obs-link" onClick={() => setObs(o.id)}>
              {hms(o.t)}Z
            </button>
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
        <JsonViewer data={d} rootName={d.id} defaultExpandDepth={1} maxHeight={300} label={`Configuration of ${d.id}`} />
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
                  <text transform={`scale(1,-1)`} x={s * 1.8} y={s * 0.5} fontSize={s * 1.6} fill="var(--text-0)" fontFamily="var(--font-mono)">
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
