import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FACILITY, findSensor, formatGeodetic, EnuFrame, type AlertRecord, type EvidenceRef, type Contribution } from '@strata/domain';
import { get, post, qs } from '../api/client';
import type { PatchDetail, TrackDetail, WorldChangeRow } from '../api/types';
import { useWorld } from '../state/world';
import { useTime } from '../state/time';
import { useData } from '../state/data';
import { useSession } from '../state/session';
import { ago, dateTime, enu, hms, pct, titleCase } from '../lib/format';
import { CameraFeed } from './CameraFeed';
import { ErrorNote, EvidenceLink, Loading, ObservationViewer, Prio, StateChip, useAsync } from './common';

function Header({ kind, title, chips }: { kind: string; title: string; chips?: React.ReactNode }) {
  return (
    <div className="inspector-title">
      <div className="kind">{kind}</div>
      <h2>{title}</h2>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {chips}
      </div>
    </div>
  );
}

const nowT = () => {
  const s = useTime.getState();
  return s.mode === 'live' ? s.currentLiveEdge() : s.t;
};

/** Evidence Inspector for a surface — the "reality ledger" entry for a wall, roof or ground cell. */
export function EvidenceInspector({ patchId }: { patchId: string }) {
  const tq = Math.floor(nowT() / 10_000) * 10_000;
  const { data, error } = useAsync((s) => get<PatchDetail>(`/api/evidence/patch/${encodeURIComponent(patchId)}?t=${tq}`, s), [patchId, tq]);
  const [obs, setObs] = useState<string | null>(null);
  const [frameT, setFrameT] = useState<{ sensorId: string; t: number } | null>(null);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading what="evidence" />;
  const { patch, support } = data;
  const live = support.contributions.filter((c) => c.sensorKind !== 'prior' && c.lastObservedAt);
  const geometry = live.filter((c) => c.channel === 'geometry').sort((a, b) => (b.lastObservedAt ?? 0) - (a.lastObservedAt ?? 0));
  const appearance = live.filter((c) => c.channel === 'appearance').sort((a, b) => b.quality - a.quality);
  const primaryApp = appearance[0];
  const states = new Set<string>();
  if (appearance.length) states.add('CAPTURED');
  if (geometry.length) states.add('RECONSTRUCTED');
  if (!live.length) states.add(support.state);
  const title = patch.label.replace(/\((\w+)\)/, '').replace(/—/, '·').toUpperCase();
  const lastConfirmed = support.lastObservedAt;
  return (
    <div>
      <Header kind={patch.kind === 'interior' ? 'Interior space' : patch.kind === 'ground' ? 'Ground surface' : 'Surface'} title={title} chips={[...states].map((s) => <StateChip key={s} state={s} />)} />
      {data.superseded && <div className="note warn" style={{ margin: 12 }}>This surface no longer exists according to the latest LiDAR reconstruction of the structure. The prior design geometry is shown as a ghost only.</div>}
      <div className="ledger">
        <h5>Geometry</h5>
        {geometry.length ? (
          geometry.map((c) => <ContributionRow key={c.sensorId} c={c} onObs={setObs} />)
        ) : (
          <div className="big">{patch.kind === 'interior' ? 'Unknown — no sensor observes this interior' : patch.kind === 'ground' ? 'Terrain model (synthetic DEM)' : 'Site design data — not confirmed by a range sensor'}</div>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <span className="muted">Support</span>
          <div className="bar grow">
            <i style={{ width: pct(support.geometry) }} />
          </div>
          <span className="mono">{pct(support.geometry, 1)}</span>
        </div>
      </div>
      <div className="ledger">
        <h5>Appearance</h5>
        {primaryApp ? (
          <>
            <div className="big">
              {primaryApp.sensorKind === 'satellite' ? 'Overhead imagery' : 'Camera'} {primaryApp.sensorId}
            </div>
            <div className="muted">Captured {hms(primaryApp.lastObservedAt)}Z · {primaryApp.detail}</div>
            {primaryApp.sensorKind === 'camera' && primaryApp.lastObservedAt && (
              <button className="btn small" style={{ marginTop: 6 }} onClick={() => setFrameT({ sensorId: primaryApp.sensorId, t: primaryApp.lastObservedAt! })}>
                Show captured frame
              </button>
            )}
          </>
        ) : (
          <div className="big muted">No imaging sensor has observed this surface</div>
        )}
        {frameT && (
          <div style={{ marginTop: 8 }}>
            <CameraFeed sensorId={frameT.sensorId} t={frameT.t} live={false} />
          </div>
        )}
      </div>
      {appearance.length > 1 && (
        <div className="ledger">
          <h5>Secondary observations</h5>
          {appearance.slice(1).map((c) => (
            <ContributionRow key={c.sensorId} c={c} onObs={setObs} />
          ))}
        </div>
      )}
      <div className="ledger">
        <dl className="kv">
          <dt>Last physically confirmed</dt>
          <dd>{lastConfirmed ? `${ago(lastConfirmed, nowT())} (${hms(lastConfirmed)}Z)` : 'never'}</dd>
          <dt>Overall support</dt>
          <dd className="mono">{pct(support.overall, 1)} — scoring model, not a probability</dd>
          <dt>State</dt>
          <dd>{states.size ? [...states].join(' + ') : support.state}</dd>
          <dt>Generative information</dt>
          <dd>
            <b>NONE</b>
          </dd>
          {data.structure && (
            <>
              <dt>Structure version</dt>
              <dd>
                v{data.structure.version} · {data.structure.state} {data.structure.reconstructionId ? `· ${data.structure.reconstructionId}` : ''}
              </dd>
            </>
          )}
        </dl>
        <div className="muted" style={{ marginTop: 8, fontSize: 11.5 }}>
          {support.stateDetail}
        </div>
      </div>
      <div className="ledger">
        <h5>Original evidence ({data.evidence.length})</h5>
        {data.evidence.length === 0 && <div className="muted">No observation records.</div>}
        {data.evidence.map((e) => (
          <div key={`${e.kind}:${e.id}`} className="ev-row">
            <EvidenceLink ev={e} onObservation={setObs} />
            <StateChip state={e.state} />
            {e.note && <div className="meta">{e.note}</div>}
          </div>
        ))}
      </div>
      {obs && <ObservationViewer id={obs} onClose={() => setObs(null)} />}
    </div>
  );
}

function ContributionRow({ c, onObs }: { c: Contribution; onObs: (id: string) => void }) {
  const label = c.sensorKind === 'lidar' ? `LiDAR ${c.sensorId}` : c.sensorKind === 'satellite' ? `Overhead imagery ${c.sensorId}` : `Camera ${c.sensorId}`;
  return (
    <div className="ev-row">
      <span>
        {label} {c.evidenceId && c.sensorKind !== 'satellite' && <span className="ev-link mono" onClick={() => onObs(c.evidenceId!)}>record</span>}
      </span>
      <span className="mono muted">{c.lastObservedAt ? hms(c.lastObservedAt) : '—'}</span>
      <div className="meta">{c.detail}</div>
    </div>
  );
}

export function TrackInspector({ id }: { id: string }) {
  const tq = Math.floor(nowT() / 3000) * 3000;
  const { data, error } = useAsync((s) => get<TrackDetail>(`/api/tracks/${encodeURIComponent(id)}?t=${tq}`, s), [id, tq]);
  const [obs, setObs] = useState<string | null>(null);
  const flyTo = useWorld((s) => s.flyTo);
  const select = useWorld((s) => s.select);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading what="track" />;
  const tr = data.track;
  const s = data.snapshot;
  const lastHist = data.history[data.history.length - 1];
  const status = s?.status ?? lastHist?.status ?? tr.status;
  const lost = status === 'lost' || status === 'coasting';
  const state = lost ? 'INFERRED' : 'RECONSTRUCTED';
  return (
    <div>
      <Header
        kind={`Track · ${tr.category}${tr.cooperative ? ' · cooperative' : ''}`}
        title={`${tr.id}${tr.label !== tr.id ? ` — ${tr.label}` : ''}`}
        chips={
          <>
            <StateChip state={state} label={`${status}`} />
            <span className="chip">{tr.classification}</span>
            {tr.merged_into && <span className="chip">merged → {tr.merged_into}</span>}
          </>
        }
      />
      {lost && data.lastConfirmed && (
        <div className="ledger">
          <h5>Object permanence</h5>
          <div className="big">
            LAST OBSERVED <span className="mono">{hms(data.lastConfirmed.t)}Z</span>
          </div>
          <div className="muted">Position since then is not known. The possible region grows with the physical speed bound; nothing inside it is asserted.</div>
          <button className="btn small" style={{ marginTop: 8 }} onClick={() => (useTime.getState().seek(data.lastConfirmed!.t), flyTo({ x: data.lastConfirmed!.x, y: data.lastConfirmed!.y, z: data.lastConfirmed!.z }, 160))}>
            Go to last confirmed observation
          </button>
        </div>
      )}
      <div className="ledger">
        <dl className="kv">
          <dt>Confidence</dt>
          <dd className="mono">{pct(s?.confidence ?? lastHist?.confidence, 0)} (heuristic track quality)</dd>
          <dt>Position σ</dt>
          <dd className="mono">{(s?.sigmaH ?? lastHist?.sigma_h ?? 0).toFixed(1)} m</dd>
          {s && (
            <>
              <dt>Position</dt>
              <dd className="mono">
                {enu(s.position.x, s.position.y)} · {s.position.z.toFixed(0)} m
              </dd>
              <dt>Speed</dt>
              <dd className="mono">{Math.hypot(s.velocity.x, s.velocity.y).toFixed(1)} m/s</dd>
            </>
          )}
          <dt>First seen</dt>
          <dd className="mono">{dateTime(tr.first_t)}</dd>
          <dt>Last update</dt>
          <dd className="mono">{dateTime(tr.last_t)}</dd>
        </dl>
        {data.lastConfirmed && !lost && (
          <button className="btn small" style={{ marginTop: 8 }} onClick={() => flyTo({ x: data.lastConfirmed!.x, y: data.lastConfirmed!.y, z: data.lastConfirmed!.z }, 160)}>
            Fly to track
          </button>
        )}
      </div>
      <div className="ledger">
        <h5>Contributing sensors ({tr.contributors.length})</h5>
        {tr.contributors
          .slice()
          .sort((a, b) => b.count - a.count)
          .map((c) => (
            <div key={c.sensorId} className="ev-row">
              <span>
                <span className="ev-link" onClick={() => select({ kind: 'sensor', id: c.sensorId })}>
                  {c.sensorId}
                </span>{' '}
                <span className="muted">{c.sensorKind}</span>
              </span>
              <span className="mono">{c.count}×</span>
              <div className="meta">
                {hms(c.firstT)}–{hms(c.lastT)} · <span className="ev-link mono" onClick={() => setObs(c.lastObservationId)}>latest record</span>
              </div>
            </div>
          ))}
      </div>
      <div className="ledger">
        <h5>Recent evidence</h5>
        {data.observations.length === 0 && <div className="muted">No recent observation records.</div>}
        {data.observations.slice(0, 14).map((o) => (
          <div key={o.id} className="ev-row">
            <span>
              <span className="ev-link mono" onClick={() => setObs(o.id)}>
                {o.sensor_id} {hms(o.t)}
              </span>{' '}
              <span className="muted">{o.source_kind}</span>
            </span>
            <StateChip state={o.state} />
            <div className="meta">
              {Object.entries(o.quality)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(' · ') || 'nominal'}
              {o.source_kind === 'camera.detections' && Array.isArray(o.payload.bbox) && (
                <img
                  alt="detection crop"
                  style={{ display: 'block', marginTop: 4, maxHeight: 84, imageRendering: 'pixelated', border: '1px solid var(--line)' }}
                  src={`/api/media/frame?${qs({ sensorId: o.sensor_id, t: o.t, crop: (o.payload.bbox as number[]).join(','), scale: 4 })}`}
                />
              )}
            </div>
          </div>
        ))}
      </div>
      {obs && <ObservationViewer id={obs} onClose={() => setObs(null)} />}
    </div>
  );
}

export function SensorInspector({ id }: { id: string }) {
  const def = findSensor(id);
  const status = useData((s) => s.sensors[id]);
  const replay = useData((s) => s.replay);
  const viewThrough = useWorld((s) => s.viewThrough);
  const setViewThrough = useWorld((s) => s.setViewThrough);
  const project = useWorld((s) => s.projectFeed);
  const setProject = useWorld((s) => s.setProjectFeed);
  const mode = useTime((s) => s.mode);
  const t = useTime((s) => (s.mode === 'live' ? Math.floor(s.currentLiveEdge() / 2000) * 2000 : Math.floor(s.t / 1000) * 1000));
  const nav = useNavigate();
  if (!def) return <ErrorNote error={`Unknown sensor ${id}`} />;
  const st = mode === 'live' ? status?.status : replay?.sensors[id]?.status;
  const geo = 'position' in def ? new EnuFrame(FACILITY.origin).toGeodetic(def.position) : null;
  return (
    <div>
      <Header kind={`Sensor · ${def.kind}`} title={`${def.id} — ${def.name}`} chips={<span className="row" style={{ gap: 6 }}><span className={`status-dot ${st ?? 'silent'}`} /> <span className="upper">{st ?? 'unknown'}</span></span>} />
      {(def.kind === 'camera' || def.kind === 'drone') && (
        <>
          <CameraFeed sensorId={def.id} t={t} live={mode === 'live'} />
          {def.kind === 'camera' && (
            <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
              <button className={`btn small ${viewThrough === id ? 'on' : ''}`} onClick={() => setViewThrough(viewThrough === id ? null : id)}>
                {viewThrough === id ? 'Exit sensor view' : 'View through camera'}
              </button>
              <button className={`btn small ${project ? 'on' : ''}`} onClick={() => setProject(!project)} title="Project the recorded frame onto terrain using the calibrated pose">
                Project onto terrain
              </button>
            </div>
          )}
        </>
      )}
      <div className="ledger">
        <dl className="kv">
          <dt>Network segment</dt>
          <dd>{def.segment}</dd>
          {geo && (
            <>
              <dt>Position</dt>
              <dd className="mono">{formatGeodetic(geo)}</dd>
            </>
          )}
          {def.kind === 'camera' && (
            <>
              <dt>Pose</dt>
              <dd className="mono">
                hdg {def.headingDeg}° · pitch {def.pitchDeg}° · HFOV {def.hfovDeg}°
              </dd>
              <dt>Resolution / range</dt>
              <dd className="mono">
                {def.widthPx}×{def.heightPx} px · {def.rangeM} m
              </dd>
            </>
          )}
          {def.kind === 'radar' && (
            <>
              <dt>Range / update</dt>
              <dd className="mono">
                {def.rangeM} m · {def.updatePeriodS} s
              </dd>
              <dt>σ range / az</dt>
              <dd className="mono">
                {def.sigmaRangeM} m · {def.sigmaAzDeg}°
              </dd>
            </>
          )}
          {def.kind === 'lidar' && (
            <>
              <dt>Scan</dt>
              <dd className="mono">
                {def.azimuthSteps}×{def.elevationSteps} rays · every {def.scanPeriodS} s · {def.rangeM} m
              </dd>
            </>
          )}
          {def.kind === 'satellite' && (
            <>
              <dt>Revisit / GSD</dt>
              <dd className="mono">
                {def.revisitS / 60} min · {def.groundSampleDistanceM} m
              </dd>
              <dt>Delivery latency</dt>
              <dd className="mono">{def.deliveryLatencyS / 60} min (imagery is never live video)</dd>
            </>
          )}
          <dt>Last traffic</dt>
          <dd className="mono">{status?.lastSeen ? `${hms(status.lastSeen)}Z` : '—'}</dd>
          {status?.message && (
            <>
              <dt>Message</dt>
              <dd>{status.message}</dd>
            </>
          )}
        </dl>
        <button className="btn small" style={{ marginTop: 10 }} onClick={() => nav(`/sensors/${id}`)}>
          Diagnostics
        </button>
      </div>
    </div>
  );
}

export function ChangeInspector({ id }: { id: string }) {
  const { data, error } = useAsync((s) => get<WorldChangeRow>(`/api/world/changes/${encodeURIComponent(id)}`, s), [id]);
  const [obs, setObs] = useState<string | null>(null);
  const setMode = useWorld((s) => s.setMode);
  const setDiff = useWorld((s) => s.setDiff);
  const flyTo = useWorld((s) => s.flyTo);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading what="change" />;
  return (
    <div>
      <Header kind={`Change · ${titleCase(data.kind)}`} title={data.title} chips={<StateChip state={data.state} />} />
      <div className="ledger">
        <dl className="kv">
          <dt>Detected</dt>
          <dd className="mono">{dateTime(data.t)}</dd>
          <dt>Detector</dt>
          <dd className="mono">{data.detector}</dd>
          <dt>Support</dt>
          <dd className="mono">{pct(data.confidence)}</dd>
          <dt>Location</dt>
          <dd className="mono">{enu(data.x, data.y)}</dd>
          <dt>Extent</dt>
          <dd className="mono">~{Math.round(data.extent_m)} m</dd>
        </dl>
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn small" onClick={() => flyTo({ x: data.x, y: data.y, z: data.z }, Math.max(150, data.extent_m * 6))}>
            Fly to
          </button>
          <button
            className="btn small"
            onClick={() => {
              setDiff({ a: data.t - 10 * 60_000, b: Math.min(useTime.getState().currentLiveEdge(), data.t + 10 * 60_000) });
              setMode('DIFF');
              useTime.getState().seek(data.t + 60_000);
            }}
          >
            Compare before / after
          </button>
        </div>
      </div>
      <div className="ledger">
        <h5>Supporting evidence ({data.evidence.length})</h5>
        {data.evidence.map((e: EvidenceRef, i: number) => (
          <div key={`${e.id}-${i}`} className="ev-row">
            <EvidenceLink ev={e} onObservation={setObs} />
            <StateChip state={e.state} />
            {e.note && <div className="meta">{e.note}</div>}
          </div>
        ))}
      </div>
      {obs && <ObservationViewer id={obs} onClose={() => setObs(null)} />}
    </div>
  );
}

export function AlertInspector({ id }: { id: string }) {
  const alert = useData((s) => s.alerts.find((a) => a.id === id));
  const can = useSession((s) => s.can);
  const user = useSession((s) => s.user);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [obs, setObs] = useState<string | null>(null);
  const flyTo = useWorld((s) => s.flyTo);
  const nav = useNavigate();
  if (!alert) return <ErrorNote error="Alert not loaded" />;
  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      const a = await post<AlertRecord>(`/api/alerts/${alert.id}/${path}`, body);
      useData.getState().onLive({ type: 'alert', alert: a });
    } finally {
      setBusy(false);
    }
  };
  const createIncident = async () => {
    if (!alert.position) return;
    const inc = await post<{ id: string }>('/api/incidents', { title: alert.title, t: alert.t, x: alert.position.x, y: alert.position.y, radiusM: 400, alertId: alert.id });
    nav(`/incidents/${inc.id}`);
  };
  return (
    <div>
      <Header kind={`Alert · ${alert.rule}`} title={alert.title} chips={<><Prio p={alert.priority} /> <span className="upper">{alert.priority}</span> <span className="chip">{alert.status}</span></>} />
      <div className="ledger">
        <dl className="kv">
          <dt>Raised</dt>
          <dd className="mono">{dateTime(alert.t)}</dd>
          <dt>Source</dt>
          <dd className="mono">{alert.source}</dd>
          {alert.trackId && (
            <>
              <dt>Track</dt>
              <dd>
                <span className="ev-link" onClick={() => useWorld.getState().select({ kind: 'track', id: alert.trackId! })}>
                  {alert.trackId}
                </span>
              </dd>
            </>
          )}
          <dt>Assigned</dt>
          <dd>{alert.assignedTo ?? '—'}</dd>
          <dt>Acknowledged</dt>
          <dd>{alert.ackBy ? `${alert.ackBy} at ${hms(alert.ackAt)}Z` : '—'}</dd>
          {alert.incidentId && (
            <>
              <dt>Incident</dt>
              <dd>
                <span className="ev-link" onClick={() => nav(`/incidents/${alert.incidentId}`)}>
                  open investigation
                </span>
              </dd>
            </>
          )}
        </dl>
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          {alert.position && (
            <button className="btn small" onClick={() => (useTime.getState().seek(alert.t), flyTo(alert.position!, 260))}>
              Go to location & time
            </button>
          )}
          {can('alerts.acknowledge') && alert.status === 'open' && (
            <button className="btn small primary" disabled={busy} onClick={() => void act('ack')}>
              Acknowledge
            </button>
          )}
          {can('alerts.assign') && (
            <button className="btn small" disabled={busy} onClick={() => void act('assign', { assignee: user?.username })}>
              Assign to me
            </button>
          )}
          {can('alerts.acknowledge') && alert.status !== 'resolved' && (
            <button className="btn small" disabled={busy} onClick={() => void act('resolve')}>
              Resolve
            </button>
          )}
          {can('incidents.create') && !alert.incidentId && alert.position && (
            <button className="btn small" onClick={() => void createIncident()}>
              Open incident
            </button>
          )}
        </div>
      </div>
      <div className="ledger">
        <h5>Evidence</h5>
        {alert.evidence.map((e, i) => (
          <div key={`${e.id}-${i}`} className="ev-row">
            <EvidenceLink ev={e} onObservation={setObs} />
            <StateChip state={e.state} />
            {e.note && <div className="meta">{e.note}</div>}
          </div>
        ))}
      </div>
      <div className="ledger">
        <h5>Notes</h5>
        {alert.notes.map((n, i) => (
          <div key={i} className="ev-row">
            <span>{n.text}</span>
            <span className="mono muted">{hms(n.at)}</span>
            <div className="meta">{n.by}</div>
          </div>
        ))}
        {can('alerts.acknowledge') && (
          <form
            className="row"
            style={{ marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) void act('notes', { text: note.trim() }).then(() => setNote(''));
            }}
          >
            <input className="input grow" placeholder="Add note" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn small">Add</button>
          </form>
        )}
      </div>
      {obs && <ObservationViewer id={obs} onClose={() => setObs(null)} />}
    </div>
  );
}

export function BuildingInspector({ id }: { id: string }) {
  const b = FACILITY.buildings.find((x) => x.id === id);
  const replay = useData((s) => s.replay);
  const st = replay?.structures.find((s) => s.buildingId === id);
  const patches = useWorld((s) => s.patches);
  const select = useWorld((s) => s.select);
  const own = useMemo(() => patches.filter((p) => p.ownerId === id), [patches, id]);
  if (!b) return <ErrorNote error="Unknown building" />;
  return (
    <div>
      <Header kind={`Structure · ${b.kind}`} title={`Building ${b.label} — ${b.name}`} chips={<StateChip state={st?.state ?? 'PRIOR'} label={`${st?.state ?? 'PRIOR'} · v${st?.version ?? 1}`} />} />
      <div className="ledger">
        <dl className="kv">
          <dt>Footprint</dt>
          <dd className="mono">
            {b.width} × {b.depth} m · h {b.height} m (design)
          </dd>
          <dt>Geometry source</dt>
          <dd>{st?.reconstructionId ? `LiDAR reconstruction ${st.reconstructionId}` : 'Site design data'}</dd>
          <dt>Version valid from</dt>
          <dd className="mono">{st?.validFrom ? dateTime(st.validFrom) : 'commissioning'}</dd>
        </dl>
      </div>
      <div className="ledger">
        <h5>Surfaces ({own.length}) — select for evidence</h5>
        {own.map((p) => (
          <div key={p.id} className="ev-row" style={{ cursor: 'pointer' }} onClick={() => select({ kind: 'patch', id: p.id, buildingId: id })}>
            <span>{p.label.split('—')[1]?.trim() ?? p.label}</span>
            <span className="muted">{p.kind}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ObjectInspector({ id }: { id: string }) {
  const replay = useData((s) => s.replay);
  const o = replay?.objects.find((x) => x.id === id);
  const [obs, setObs] = useState<string | null>(null);
  if (!o) return <ErrorNote error="Object not present at the selected time" />;
  return (
    <div>
      <Header kind={`Static object · ${o.kind}`} title={o.label} chips={<StateChip state={o.source === 'design data' ? (o.state === 'confirmed' ? 'CAPTURED' : 'PRIOR') : 'RECONSTRUCTED'} label={o.state} />} />
      <div className="ledger">
        <dl className="kv">
          <dt>Source</dt>
          <dd>{o.source}</dd>
          <dt>Position</dt>
          <dd className="mono">{enu(o.position.x, o.position.y)}</dd>
          <dt>Present since</dt>
          <dd className="mono">{o.validFrom ? dateTime(o.validFrom) : 'commissioning'}</dd>
          <dt>Last confirmed</dt>
          <dd className="mono">{o.lastConfirmedAt ? dateTime(o.lastConfirmedAt) : 'never confirmed by a sensor'}</dd>
        </dl>
      </div>
      <div className="ledger">
        <h5>Evidence</h5>
        {o.evidence.length === 0 && <div className="muted">None — expected from design data only.</div>}
        {o.evidence.map((e, i) => (
          <div key={i} className="ev-row">
            <EvidenceLink ev={e} onObservation={setObs} />
            <StateChip state={e.state} />
            {e.note && <div className="meta">{e.note}</div>}
          </div>
        ))}
      </div>
      {obs && <ObservationViewer id={obs} onClose={() => setObs(null)} />}
    </div>
  );
}

export function PointInspector({ x, y, z }: { x: number; y: number; z: number }) {
  const geo = new EnuFrame(FACILITY.origin).toGeodetic({ x, y, z });
  const can = useSession((s) => s.can);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const inc = await post<{ id: string }>('/api/incidents', { title: `Manual incident at E${Math.round(x)} N${Math.round(y)}`, t: Math.round(nowT()), x, y, radiusM: 300 });
      nav(`/incidents/${inc.id}`);
    } finally {
      setBusy(false);
    }
  };
  const cell = `ground:${Math.floor(x / 80)}:${Math.floor(y / 80)}`;
  return (
    <div>
      <Header kind="Location" title={enu(x, y)} />
      <div className="ledger">
        <dl className="kv">
          <dt>WGS84</dt>
          <dd className="mono">{formatGeodetic(geo)}</dd>
          <dt>Elevation</dt>
          <dd className="mono">{z.toFixed(1)} m (synthetic DEM)</dd>
        </dl>
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn small" onClick={() => useWorld.getState().select({ kind: 'patch', id: cell })}>
            Ground evidence
          </button>
          {can('incidents.create') && (
            <button className="btn small" disabled={busy} onClick={() => void create()}>
              Create incident here
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
