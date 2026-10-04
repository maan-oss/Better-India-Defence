import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { IncidentRecord } from '@strata/domain';
import { get, patch, post } from '../api/client';
import type { IncidentPackage } from '../api/types';
import { useData } from '../state/data';
import { useWorld } from '../state/world';
import { useTime } from '../state/time';
import { useSession } from '../state/session';
import { ErrorNote, Loading, Prio, StateChip, useAsync } from '../components/common';
import { dateTime, dur, hms } from '../lib/format';

/** INCIDENTS — investigation library and incident files. */
export function Incidents() {
  const { id } = useParams();
  const incidents = useData((s) => s.incidents);
  const nav = useNavigate();
  const can = useSession((s) => s.can);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    void useData.getState().loadInitial();
  }, []);
  return (
    <div className="page">
      <div className="page-h">
        <h1>Incidents</h1>
        <span className="sub">Investigations anchored in space and time. Evidence is gathered automatically from the incident window.</span>
        <div className="spacer" />
        {can('incidents.create') && (
          <button className="btn" onClick={() => setCreating(true)}>
            New incident
          </button>
        )}
      </div>
      <div className="page-body split">
        <div className="scroll">
          {incidents.length === 0 && <div className="empty">No incidents recorded.</div>}
          {incidents.map((i) => (
            <div key={i.id} className={`list-row ${i.id === id || i.code === id ? 'sel' : ''}`} style={{ padding: '10px 16px' }} onClick={() => nav(`/incidents/${i.id}`)}>
              <span className="mono" style={{ width: 110 }}>
                {i.code}
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis">{i.title}</div>
                <div className="muted mono" style={{ fontSize: 11 }}>
                  {dateTime(i.tStart)} · {dur(i.tEnd - i.tStart)} · {i.alertIds.length} alert(s)
                </div>
              </div>
              <span className="chip">{i.status}</span>
            </div>
          ))}
        </div>
        <div className="scroll">{creating ? <CreateIncident onDone={(nid) => (setCreating(false), nid && nav(`/incidents/${nid}`))} /> : id ? <IncidentFile id={id} /> : <div className="empty">Select an incident.</div>}</div>
      </div>
    </div>
  );
}

function IncidentFile({ id }: { id: string }) {
  const { data, error, reload } = useAsync((s) => get<IncidentPackage>(`/api/incidents/${encodeURIComponent(id)}`, s), [id]);
  const nav = useNavigate();
  const can = useSession((s) => s.can);
  const [summary, setSummary] = useState('');
  useEffect(() => setSummary(data?.incident.summary ?? ''), [data]);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading what="incident file" />;
  const inc = data.incident;
  const enter = () => {
    const w = useWorld.getState();
    w.setIncident(inc.id);
    w.select(null);
    w.setMode('INCIDENT');
    useTime.getState().seek(inc.tStart);
    nav('/operations');
  };
  const setStatus = async (status: IncidentRecord['status']) => {
    await patch(`/api/incidents/${inc.id}`, { status });
    reload();
  };
  const exportFile = async () => {
    const res = await fetch(`/api/incidents/${inc.id}/export`, { method: 'POST', credentials: 'same-origin' });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${inc.code}.json`;
    a.click();
  };
  return (
    <div className="reveal">
      <div className="section">
        <div className="upper muted">
          {inc.code} · {inc.status} · created by {inc.createdBy}
        </div>
        <h2 style={{ fontWeight: 500, fontSize: 18, margin: '4px 0 6px' }}>{inc.title}</h2>
        <div className="mono muted">
          {dateTime(inc.tStart)} → {hms(inc.tEnd)}Z · centre E {inc.center.x.toFixed(0)} N {inc.center.y.toFixed(0)} · radius {Math.round(inc.radiusM)} m
        </div>
        <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={enter}>
            Enter reconstruction environment
          </button>
          {can('incidents.edit') && (
            <div className="seg">
              {(['open', 'investigating', 'closed'] as const).map((s) => (
                <button key={s} className={inc.status === s ? 'on' : ''} onClick={() => void setStatus(s)}>
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          {can('evidence.export') && (
            <button className="btn" onClick={() => void exportFile()}>
              Export evidence package
            </button>
          )}
        </div>
      </div>
      <div className="section">
        <h4>Summary</h4>
        {can('incidents.edit') ? (
          <div className="col">
            <textarea className="input" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
            <div>
              <button className="btn small" onClick={() => void patch(`/api/incidents/${inc.id}`, { summary }).then(reload)}>
                Save summary
              </button>
            </div>
          </div>
        ) : (
          <div>{inc.summary || <span className="muted">No summary.</span>}</div>
        )}
      </div>
      {data.stoppedBefore.length > 0 && (
        <div className="section">
          <h4>Sensors not reporting at incident start</h4>
          <table className="table">
            <tbody>
              {data.stoppedBefore.map((s) => (
                <tr key={s.sensorId + s.t}>
                  <td className="mono">{s.sensorId}</td>
                  <td>{s.status}</td>
                  <td className="mono">from {hms(s.t)}Z</td>
                  <td className="mono">{s.restoredAt ? `restored ${hms(s.restoredAt)}Z` : 'not restored'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="section">
        <h4>Evidence gathered from the window ({data.sensors.length} sensors)</h4>
        <table className="table">
          <thead>
            <tr>
              <th>Sensor</th>
              <th>Why</th>
              <th>Obs.</th>
              <th>Window</th>
            </tr>
          </thead>
          <tbody>
            {data.sensors.map((s) => (
              <tr key={s.sensorId}>
                <td className="mono">
                  {s.sensorId} <span className="muted">{s.kind}</span>
                </td>
                <td className="muted">{s.reason}</td>
                <td className="mono">{s.observations}</td>
                <td className="mono muted">{s.firstT ? `${hms(s.firstT)}–${hms(s.lastT)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="section">
        <h4>Tracks ({data.tracks.length})</h4>
        <table className="table">
          <tbody>
            {data.tracks.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.id}</td>
                <td>{t.cooperative ? t.label : t.category}</td>
                <td className="mono muted">
                  {hms(t.firstT)}–{hms(t.lastT)}
                </td>
                <td className="mono">{t.minDistanceM} m</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="section">
        <h4>Alerts</h4>
        {data.alerts.map((a) => (
          <div key={a.id} className="row" style={{ padding: '4px 0' }}>
            <Prio p={a.priority} /> <span className="mono muted">{hms(a.t)}</span> {a.title}
          </div>
        ))}
      </div>
      <div className="section">
        <h4>Pinned evidence ({inc.evidence.length})</h4>
        {inc.evidence.length === 0 && <div className="muted">Nothing pinned yet. Use the camera inspector in the reconstruction environment to preserve frames.</div>}
        {inc.evidence.map((e, i) => (
          <div key={i} className="row" style={{ padding: '3px 0' }}>
            <StateChip state={e.state} /> <span className="mono">{e.kind}</span> <span className="mono muted">{e.id}</span> {e.note}
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateIncident({ onDone }: { onDone: (id: string | null) => void }) {
  const t = useTime.getState();
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(new Date(t.mode === 'live' ? t.currentLiveEdge() : t.t).toISOString().slice(0, 19));
  const [x, setX] = useState('0');
  const [y, setY] = useState('0');
  const [r, setR] = useState('300');
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    try {
      const inc = await post<{ id: string }>('/api/incidents', { title, t: Date.parse(`${when}Z`), x: Number(x), y: Number(y), radiusM: Number(r) });
      onDone(inc.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    }
  };
  return (
    <div className="section col" style={{ maxWidth: 520 }}>
      <h4>New incident</h4>
      <label className="col">
        <span className="muted">Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="col">
        <span className="muted">Time (UTC)</span>
        <input className="input mono" value={when} onChange={(e) => setWhen(e.target.value)} />
      </label>
      <div className="row">
        <label className="col grow">
          <span className="muted">East (m)</span>
          <input className="input mono" value={x} onChange={(e) => setX(e.target.value)} />
        </label>
        <label className="col grow">
          <span className="muted">North (m)</span>
          <input className="input mono" value={y} onChange={(e) => setY(e.target.value)} />
        </label>
        <label className="col grow">
          <span className="muted">Radius (m)</span>
          <input className="input mono" value={r} onChange={(e) => setR(e.target.value)} />
        </label>
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        Tip: in Operations, click a location in the world and choose “Create incident here”.
      </div>
      {err && <div className="note warn">{err}</div>}
      <div className="row">
        <button className="btn primary" disabled={title.length < 3} onClick={() => void submit()}>
          Create
        </button>
        <button className="btn ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
