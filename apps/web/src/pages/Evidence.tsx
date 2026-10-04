import { useMemo, useState } from 'react';
import { FACILITY } from '@strata/domain';
import { get, post, qs } from '../api/client';
import type { HandoffResponse } from '../api/types';
import { ErrorNote, Loading, ObservationViewer, StateChip, useAsync } from '../components/common';
import { useSession } from '../state/session';
import { useTime } from '../state/time';
import { useWorld } from '../state/world';
import { useNavigate } from 'react-router-dom';
import { bytes, dateTime, dur, hms, pct } from '../lib/format';

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
        <div className="seg">
          <button className={tab === 'observations' ? 'on' : ''} onClick={() => setTab('observations')}>
            OBSERVATIONS
          </button>
          <button className={tab === 'media' ? 'on' : ''} onClick={() => setTab('media')}>
            MEDIA
          </button>
          {can('handoff.search') && (
            <button className={tab === 'handoff' ? 'on' : ''} onClick={() => setTab('handoff')}>
              IDENTITY HAND-OFF (TEST)
            </button>
          )}
        </div>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {tab === 'observations' && <ObservationSearch />}
        {tab === 'media' && <MediaList />}
        {tab === 'handoff' && <Handoff />}
      </div>
    </div>
  );
}

function ObservationSearch() {
  const [sensorId, setSensor] = useState('');
  const [kind, setKind] = useState('');
  const [state, setState] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [q, setQ] = useState({ sensorId: '', kind: '', state: '', flagged: false });
  const [obs, setObs] = useState<string | null>(null);
  const { data, error, loading } = useAsync(
    (s) => get<{ id: string; sensor_id: string; kind: string; source_kind: string; t: number; received_at: number; state: string; quality: Record<string, unknown>; x: number | null; y: number | null; adapter: string }[]>(`/api/evidence/search?${qs({ sensorId: q.sensorId, kind: q.kind, state: q.state, flagged: q.flagged ? '1' : undefined, limit: 300 })}`, s),
    [q],
  );
  return (
    <div>
      <form
        className="row section"
        onSubmit={(e) => {
          e.preventDefault();
          setQ({ sensorId, kind, state, flagged });
        }}
      >
        <input className="input" placeholder="Sensor (e.g. C12)" value={sensorId} onChange={(e) => setSensor(e.target.value)} />
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Any kind</option>
          {['track', 'media', 'position', 'rf', 'spatial', 'imagery', 'infrastructure', 'health'].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">Any state</option>
          <option>CAPTURED</option>
          <option>RECONSTRUCTED</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} /> quality-flagged only (late, out-of-order, derived…)
        </label>
        <button className="btn">Search</button>
      </form>
      {error && <ErrorNote error={error} />}
      {loading && <Loading />}
      <table className="table">
        <thead>
          <tr>
            <th>Observed</th>
            <th>Sensor</th>
            <th>Kind</th>
            <th>State</th>
            <th>Latency</th>
            <th>Flags</th>
            <th>Adapter</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((o) => (
            <tr key={o.id} className="click" onClick={() => setObs(o.id)}>
              <td className="mono">{dateTime(o.t)}</td>
              <td className="mono">{o.sensor_id}</td>
              <td>{o.source_kind}</td>
              <td>
                <StateChip state={o.state} />
              </td>
              <td className="mono muted">{((o.received_at - o.t) / 1000).toFixed(1)} s</td>
              <td className="mono muted">
                {Object.entries(o.quality)
                  .filter(([, v]) => v)
                  .map(([k]) => k)
                  .join(' ')}
              </td>
              <td className="mono dim">{o.adapter}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
        <div className="seg">
          {['imagery', 'pointcloud', 'reconstruction', 'frame'].map((k) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {k.toUpperCase()}
            </button>
          ))}
        </div>
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
              <div className="v" style={{ color: 'var(--amber)' }}>
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
