import { useMemo, useState } from 'react';
import { FACILITY } from '@strata/domain';
import { get, post, qs } from '../api/client';
import type { HandoffResponse } from '../api/types';
import { ErrorNote, Loading, ObservationViewer, StateChip, useAsync } from '../components/common';
import { useSession } from '../state/session';
import { useTime } from '../state/time';
import { useWorld } from '../state/world';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { bytes, dateTime, dur, hms, pct } from '../lib/format';
import { Segmented, Tabs } from '../components/ui';
import { DateRangePicker, FilterToolbar, Pagination, SearchField, Ridgeline, SortableDataTable, Streamgraph, type DateRange, type FilterChip } from '../components/kit';
import { Empty } from '../brand/Boot';

/** EVIDENCE — searchable repository of observations and media, plus the safe hand-off demonstration. */
export function Evidence() {
  const [tab, setTab] = useState<'observations' | 'media' | 'handoff'>('observations');
  const can = useSession((s) => s.can);
  return (
    <div className="page">
      <div className="page-h">
        <h1>Evidence</h1>
        <span className="sub">Original records remain accessible. Derived products always reference them.</span>
        <div className="spacer" />
        <Tabs
          label="Evidence views"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'observations', label: 'Observations' },
            { value: 'media', label: 'Media' },
            ...(can('handoff.search') ? [{ value: 'handoff' as const, label: 'Identity hand-off (test)' }] : []),
          ]}
        />
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {tab === 'observations' && <ObservationSearch />}
        {tab === 'media' && <MediaList />}
        {tab === 'handoff' && <Handoff />}
      </div>
    </div>
  );
}

type ObsRow = { id: string; sensor_id: string; kind: string; source_kind: string; t: number; received_at: number; state: string; quality: Record<string, unknown>; x: number | null; y: number | null; adapter: string };
const KINDS = ['track', 'media', 'position', 'rf', 'spatial', 'imagery', 'infrastructure', 'health'];

function ObservationSearch() {
  const [params] = useSearchParams();
  const [sensorId, setSensor] = useState(() => params.get('sensor') ?? '');
  const [filters, setFilters] = useState<FilterChip[]>([]);
  const [range, setRange] = useState<DateRange | null>(null);
  const [obs, setObs] = useState<string | null>(null);
  const val = (id: string) => filters.find((f) => f.id === id)?.value;
  const query = { sensorId: sensorId.trim().toUpperCase(), kind: val('kind'), state: val('state'), flagged: val('quality') ? '1' : undefined, from: range ? range.start.getTime() : undefined, to: range ? range.end.getTime() + 86_399_999 : undefined, limit: 500 };
  const key = JSON.stringify(query);
  const { data, error, loading } = useAsync((s) => get<ObsRow[]>(`/api/evidence/search?${qs(query)}`, s), [key]);
  const rows = useMemo(() => data ?? [], [data]);
  const [page, setPage] = useState(1);
  const PER = 50;
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const pg = Math.min(page, pages);
  // Observations over the result's time span, by kind (Arc streamgraph): what the record holds, and when.
  const stream = useMemo(() => {
    if (rows.length < 4) return null;
    const t0 = Math.min(...rows.map((r) => r.t));
    const t1 = Math.max(...rows.map((r) => r.t));
    const n = 16;
    const w = Math.max(1, (t1 - t0) / n);
    const kinds = [...new Set(rows.map((r) => r.source_kind))].slice(0, 6);
    const bins = Array.from({ length: n }, (_, i) => ({ key: String(i), label: dateTime(t0 + i * w), axisLabel: t1 - t0 < 3_600_000 ? hms(t0 + i * w) : hms(t0 + i * w).slice(0, 5), values: Object.fromEntries(kinds.map((k) => [k, 0])) as Record<string, number> }));
    for (const r of rows) {
      const i = Math.min(n - 1, Math.floor((r.t - t0) / w));
      if (kinds.includes(r.source_kind)) bins[i]!.values[r.source_kind] = (bins[i]!.values[r.source_kind] ?? 0) + 1;
    }
    return { bins, series: kinds.map((k) => ({ key: k, label: k })) };
  }, [rows]);
  // Delivery latency (received − observed) by source kind (Arc ridgeline): a slow or bursty link shows as a long tail.
  const latency = useMemo(() => {
    const by = new Map<string, number[]>();
    for (const r of rows) {
      const v = (r.received_at - r.t) / 1000;
      if (!Number.isFinite(v) || v < 0) continue;
      const list = by.get(r.source_kind) ?? [];
      list.push(v);
      by.set(r.source_kind, list);
    }
    const series = [...by.entries()].filter(([, v]) => v.length >= 5).map(([k, v]) => ({ id: k, label: k, values: v }));
    if (series.length < 1) return null;
    const all = series.flatMap((x) => x.values).sort((a, b) => a - b);
    const p99 = all[Math.floor(all.length * 0.99)] ?? all[all.length - 1] ?? 1;
    return { series, domain: [0, Math.max(0.5, p99)] as [number, number] };
  }, [rows]);
  return (
    <div className="ev-obs">
      <div className="ev-filters">
        <div style={{ width: 220 }}>
          <SearchField label="Sensor" placeholder="e.g. C12" value={sensorId} onValueChange={setSensor} />
        </div>
        <div style={{ width: 280 }}>
          <DateRangePicker label="Observed between" value={range} onChange={setRange} maxDate={new Date()} />
        </div>
        <div className="ev-chips">
          <FilterToolbar
            filters={filters}
            onRemove={(id) => setFilters((f) => f.filter((x) => x.id !== id))}
            onClearAll={() => setFilters([])}
            addFilter={{
              label: 'Add filter',
              align: 'start',
              fields: [
                { id: 'kind', label: 'Kind', options: KINDS },
                { id: 'state', label: 'State', options: [{ value: 'CAPTURED', label: 'Captured' }, { value: 'RECONSTRUCTED', label: 'Reconstructed' }, { value: 'INFERRED', label: 'Inferred' }] },
                { id: 'quality', label: 'Quality', options: [{ value: '1', label: 'Flagged only (late, out of order, derived)' }] },
              ],
              onAdd: (chip, field) => setFilters((f) => [...f.filter((x) => x.id !== field.id), { id: field.id, label: field.label, value: chip.value }]),
            }}
          />
        </div>
      </div>
      {error && <ErrorNote error={error} />}
      {loading && !data && <Loading what="observations" />}
      {stream && (
        <div className="ev-stream">
          <Streamgraph data={stream.bins} series={stream.series} label="Observations by kind" unit="obs" height={150} categoryLabel="Time" offset="silhouette" />
          {latency && <Ridgeline series={latency.series} domain={latency.domain} label="Delivery latency by kind" unit="s" formatValue={(v) => `${latency.domain[1] < 2 ? v.toFixed(2) : v.toFixed(1)} s`} rowHeight={26} />}
        </div>
      )}
      {data && rows.length === 0 ? (
        <Empty compact art="search" title="No observations match" description="Widen the time range, or remove a filter." />
      ) : (
        <div className="ev-table">
          <SortableDataTable
            caption="Observations"
            rowKey="id"
            itemName={{ one: 'observation', other: 'observations' }}
            defaultSort={{ key: 't', direction: 'desc' }}
            rows={rows.slice((pg - 1) * PER, pg * PER).map((o) => ({ ...o, latency: (o.received_at - o.t) / 1000, flags: Object.entries(o.quality).filter(([, v]) => v).map(([k]) => k).join(' ') }))}
            columns={[
              { key: 't', label: 'Observed', sortable: true, render: (v, r) => <button className="obs-link mono" onClick={() => setObs(String(r.id))}>{dateTime(Number(v))}</button> },
              { key: 'sensor_id', label: 'Sensor', sortable: true, render: (v) => <span className="mono">{String(v)}</span> },
              { key: 'source_kind', label: 'Kind', sortable: true },
              { key: 'state', label: 'State', sortable: true, render: (v) => <StateChip state={String(v)} /> },
              { key: 'latency', label: 'Latency', sortable: true, numeric: true, render: (v) => `${Number(v).toFixed(1)} s` },
              { key: 'flags', label: 'Flags', render: (v) => <span className="mono muted">{String(v)}</span> },
              { key: 'adapter', label: 'Adapter', sortable: true, render: (v) => <span className="mono dim">{String(v)}</span> },
            ]}
          />
          {pages > 1 && (
            <div className="audit-pager">
              <Pagination page={pg} pageCount={pages} onPageChange={setPage} label="Observation pages" />
            </div>
          )}
        </div>
      )}
      {obs && <ObservationViewer id={obs} onClose={() => setObs(null)} />}
    </div>
  );
}

function MediaList() {
  const [kind, setKind] = useState('imagery');
  const { data, error } = useAsync((s) => get<{ id: string; sensor_id: string; kind: string; captured_at: number; content_type: string; bytes: number; sha256: string; encrypted: boolean; meta: Record<string, unknown> }[]>(`/api/media?${qs({ kind })}`, s), [kind]);
  return (
    <div>
      <div className="row section">
        <Segmented
          label="Media kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'imagery', label: 'Imagery' },
            { value: 'pointcloud', label: 'Point clouds' },
            { value: 'reconstruction', label: 'Reconstructions' },
            { value: 'frame', label: 'Frames' },
          ]}
        />
        <span className="muted">{kind === 'frame' ? 'Frames preserved as evidence (recorded frames otherwise remain in the VMS).' : kind === 'imagery' ? 'Satellite captures show their acquisition time — imagery is periodic, never live video.' : ''}</span>
      </div>
      {error && <ErrorNote error={error} />}
      {kind === 'imagery' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, padding: 16 }}>
          {(data ?? []).map((m) => (
            <a key={m.id} href={`/api/media/${encodeURIComponent(m.id)}`} target="_blank" rel="noopener" className="panel" style={{ textDecoration: 'none' }}>
              <img src={`/api/media/${encodeURIComponent(m.id)}`} alt={`capture ${m.id}`} style={{ width: '100%', display: 'block', aspectRatio: '1/1', objectFit: 'cover' }} loading="lazy" />
              <div style={{ padding: 8 }}>
                <div className="row">
                  <StateChip state="CAPTURED" /> <span className="mono">{hms(m.captured_at)}Z</span>
                </div>
                <div className="muted mono" style={{ fontSize: 11 }}>
                  acquired {dateTime(m.captured_at)} · {String(m.meta.gsdM ?? '')} m GSD · delivered {m.meta.deliveredAt ? hms(Number(m.meta.deliveredAt)) : '—'}
                </div>
              </div>
            </a>
          ))}
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Captured</th>
              <th>Sensor</th>
              <th>Id</th>
              <th>Size</th>
              <th>SHA-256</th>
              <th>At rest</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((m) => (
              <tr key={m.id}>
                <td className="mono">{dateTime(m.captured_at)}</td>
                <td className="mono">{m.sensor_id}</td>
                <td>
                  <a className="mono" href={`/api/media/${encodeURIComponent(m.id)}`} target="_blank" rel="noopener">
                    {m.id}
                  </a>
                </td>
                <td className="mono">{bytes(m.bytes)}</td>
                <td className="mono dim">{m.sha256.slice(0, 16)}…</td>
                <td>{m.encrypted ? 'encrypted' : 'plain'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Handoff() {
  const { data: subjects } = useAsync((s) => get<{ id: string; label: string; consentRef: string; synthetic: boolean; enrolledAt: number }[]>('/api/handoff/subjects', s), []);
  const [subject, setSubject] = useState('');
  const [purpose, setPurpose] = useState('Hand-off demonstration — synthetic test identity');
  const [res, setRes] = useState<HandoffResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const run = async () => {
    const t = useTime.getState();
    const to = t.currentLiveEdge();
    const from = Math.max(t.rangeFrom, to - 3 * 3600_000 + 60_000);
    setBusy(true);
    setErr(null);
    try {
      setRes(await post<HandoffResponse>('/api/handoff/search', { subjectId: subject || subjects?.[0]?.id, from: Math.round(from), to: Math.round(to), purpose }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };
  const showInWorld = (t: number, cam: string) => {
    useTime.getState().seek(t);
    useTime.getState().setPlaying(false);
    const c = FACILITY.sensors.find((s) => s.id === cam);
    const w = useWorld.getState();
    if (c && 'position' in c) w.flyTo(c.position, 260);
    w.select({ kind: 'sensor', id: cam });
    nav('/operations');
  };
  const segmentsWithGaps = useMemo(() => {
    if (!res) return [];
    const out: ({ type: 'seg'; seg: HandoffResponse['result']['segments'][number] } | { type: 'gap'; gap: HandoffResponse['result']['blindIntervals'][number] })[] = [];
    res.result.segments.forEach((s, i) => {
      if (i > 0) {
        const g = res.result.blindIntervals.find((b) => b.toCamera === s.cameraId && Math.abs(b.toT - s.fromT) < 15_000);
        if (g) out.push({ type: 'gap', gap: g });
      }
      out.push({ type: 'seg', seg: s });
    });
    return out;
  }, [res]);
  return (
    <div style={{ maxWidth: 1100 }}>
      <div className="section col">
        <div className="note warn">
          Restricted demonstration. Only enrolled <b>synthetic or consenting</b> test identities can be searched. Every search is audited with its stated purpose. Appearance similarity comes from a synthetic re-identification descriptor; the platform performs no facial recognition. Results are candidates for human review, never identifications.
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select className="input" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Test subject">
            {(subjects ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} · {s.consentRef}
              </option>
            ))}
          </select>
          <input className="input grow" value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="Purpose" />
          <button className="btn primary" disabled={busy || !subjects?.length} onClick={() => void run()}>
            {busy ? 'Searching…' : 'Search recorded observations (last 3 h)'}
          </button>
        </div>
        {subjects && subjects.length === 0 && <div className="muted">No test subjects enrolled.</div>}
        {err && <div className="note warn">{err}</div>}
      </div>
      {res && (
        <div className="reveal">
          <div className="cards">
            <div className="stat">
              <div className="v">{pct(res.result.candidateMatch)}</div>
              <div className="l">Candidate match</div>
            </div>
            <div className="stat">
              <div className="v">{res.result.pathConsistency}</div>
              <div className="l">Path consistency</div>
            </div>
            <div className="stat">
              <div className="v">{res.result.faceEvidence}</div>
              <div className="l">Face evidence (image quality)</div>
            </div>
            <div className="stat">
              <div className="v" style={{ color: 'var(--caution)' }}>
                {res.result.identityState}
              </div>
              <div className="l">Identity state · human review required</div>
            </div>
          </div>
          <div className="section">
            <h4>Observed sequence ({res.candidates} person observations searched)</h4>
            {segmentsWithGaps.map((x, i) =>
              x.type === 'seg' ? (
                <div key={i} className="row" style={{ padding: '10px 0', borderTop: '1px solid var(--line)', alignItems: 'flex-start' }}>
                  <div style={{ width: 120 }}>
                    <div className="mono" style={{ fontSize: 15 }}>
                      {x.seg.cameraId}
                    </div>
                    <div className="muted mono" style={{ fontSize: 11 }}>
                      {hms(x.seg.fromT)}–{hms(x.seg.toT)}Z
                    </div>
                    <StateChip state="CAPTURED" />
                  </div>
                  <div className="grow">
                    <div>
                      {x.seg.observations} observation(s) · appearance {pct(x.seg.meanAppearance)} · best sharpness {pct(x.seg.bestSharpness)}
                    </div>
                    <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      {res.appearances
                        .filter((a) => a.cameraId === x.seg.cameraId && a.t >= x.seg.fromT && a.t <= x.seg.toT)
                        .slice(0, 6)
                        .map((a) => (
                          <img key={a.observationId} title={`${hms(a.t)} · score ${a.score}`} style={{ height: 72, imageRendering: 'pixelated', border: '1px solid var(--line-2)' }} src={`/api/media/frame?${qs({ sensorId: a.cameraId, t: a.t, crop: a.bbox.join(','), scale: 4, audit: 1 })}`} alt="candidate appearance" />
                        ))}
                    </div>
                  </div>
                  <button className="btn small" onClick={() => showInWorld(x.seg.fromT, x.seg.cameraId)}>
                    Show in world
                  </button>
                </div>
              ) : (
                <div key={i} className="row" style={{ padding: '10px 0 10px 12px', borderTop: '1px dashed var(--line-2)', color: 'var(--inferred)' }}>
                  <StateChip state="INFERRED" label="blind interval" />
                  <span>
                    {hms(x.gap.fromT)}–{hms(x.gap.toT)}Z · {dur(x.gap.toT - x.gap.fromT)} unobserved between {x.gap.fromCamera} and {x.gap.toCamera}. Reachable region up to {Math.round(x.gap.maxDetourM)} m path length. No path is drawn through this interval.
                  </span>
                </div>
              ),
            )}
          </div>
          <div className="section">
            <h4>Rationale</h4>
            {res.result.rationale.map((r, i) => (
              <div key={i} className="muted">
                · {r}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
