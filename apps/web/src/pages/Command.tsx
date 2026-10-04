import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { dtg, READINESS_LEVELS, terrainHeight, type ThreatAssessment } from '@strata/domain';
import { get, post, put } from '../api/client';
import { useOps, grid } from '../state/ops';
import { useSession } from '../state/session';
import { useData } from '../state/data';
import { useWorld } from '../state/world';
import { ErrorNote, Loading, Modal, Prio, useAsync } from '../components/common';
import { DispatchDialog, type Task, type Team } from '../components/ops/OpsWidgets';
import { TacticalScope } from '../components/ops/TacticalScope';
import { Spark } from '../components/charts';
import { useVisionLive } from '../api/vision';
import { useTime } from '../state/time';
import { tracks as trackStore, type RenderTrack } from '../state/tracks';
import '../styles/command.css';

/**
 * COMMAND — the duty officer's console: readiness, threat evaluation, response teams and tasking,
 * occurrence book, watch handover and SITREPs. Decision support and record-keeping; no effector control.
 */
type Tab = 'OVERVIEW' | 'DUTY LOG' | 'HANDOVER' | 'SITREP' | 'ASSETS';

export function Command() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab')?.toUpperCase().replace('-', ' ') as Tab | undefined) ?? 'OVERVIEW';
  return (
    <div className="page">
      <div className="page-h">
        <h1>Command</h1>
        <span className="sub">Readiness, threats, response and reporting. All times Zulu; grid references MGRS.</span>
        <div className="spacer" />
        <div className="seg">
          {(['OVERVIEW', 'DUTY LOG', 'HANDOVER', 'SITREP', 'ASSETS'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setParams({ tab: t })}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="page-body" style={{ gridTemplateColumns: '1fr' }}>
        {tab === 'OVERVIEW' && <Overview />}
        {tab === 'DUTY LOG' && <DutyLog />}
        {tab === 'HANDOVER' && <Handover />}
        {tab === 'SITREP' && <Sitreps />}
        {tab === 'ASSETS' && <Assets />}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------------------

function Overview() {
  const version = useOps((s) => s.version);
  return (
    <div className="scroll" style={{ minHeight: 0 }}>
      <Kpis version={version} />
      <div className="cmd-grid">
        <ReadinessPanel />
        <ThreatBoard />
        <TacticalScope />
        <TeamsPanel version={version} />
        <TasksPanel version={version} />
      </div>
    </div>
  );
}

/** At-a-glance state of the watch. Each figure links to where it is worked. */
function Kpis({ version }: { version: number }) {
  const alerts = useData((s) => s.alerts);
  const sensors = useData((s) => s.sensors);
  const threats = useOps((s) => s.threats);
  const pending = useVisionLive((s) => s.pendingReview);
  const nav = useNavigate();
  const teams = useAsync((sig) => get<Team[]>('/api/ops/teams', sig), [version]);
  const [trk, setTrk] = useState<RenderTrack[]>([]);
  useEffect(() => {
    const pull = () => setTrk(trackStore.liveAt(useTime.getState().currentLiveEdge()));
    pull();
    const id = setInterval(pull, 2000);
    return () => clearInterval(id);
  }, []);
  const open = alerts.filter((a) => a.status === 'open');
  const crit = open.filter((a) => a.priority === 'critical').length;
  const edge = useTime.getState().currentLiveEdge();
  const buckets = Array.from({ length: 12 }, (_, i) => alerts.filter((a) => a.t > edge - (12 - i) * 1800_000 && a.t <= edge - (11 - i) * 1800_000).length);
  const hi = threats.filter((t) => t.level === 'CRITICAL' || t.level === 'HIGH').length;
  const nonCoop = trk.filter((t) => !t.cooperative && !t.inferred).length;
  const down = Object.values(sensors).filter((s) => s.status === 'silent' || s.status === 'offline' || s.status === 'fault').length;
  const total = Object.keys(sensors).length;
  const avail = (teams.data ?? []).filter((t) => t.status === 'AVAILABLE').length;
  const k = [
    { v: open.length, l: 'Alerts awaiting action', sub: crit ? `${crit} critical` : 'none critical', cls: crit ? 'bad' : open.length ? 'warn' : 'good', go: '/operations', spark: buckets },
    { v: hi, l: 'High / critical threats', sub: `${threats.length} contacts evaluated`, cls: hi ? 'bad' : 'good', go: '/command' },
    { v: nonCoop, l: 'Uncorrelated contacts', sub: `${trk.filter((t) => t.cooperative).length} friendly tracked`, cls: nonCoop > 20 ? 'warn' : '', go: '/operations' },
    { v: `${avail}/${teams.data?.length ?? 0}`, l: 'Response teams available', sub: `${(teams.data ?? []).filter((t) => t.status !== 'AVAILABLE' && t.status !== 'OFF DUTY').length} committed`, cls: avail === 0 && (teams.data?.length ?? 0) > 0 ? 'bad' : '', go: '/command' },
    { v: `${total - down}/${total}`, l: 'Sensors reporting', sub: down ? `${down} not reporting` : 'all nominal', cls: down ? 'warn' : 'good', go: '/sensors' },
    { v: pending, l: 'Identity reviews pending', sub: 'recognition candidates', cls: pending ? 'warn' : '', go: '/identity' },
  ];
  return (
    <div className="cards kpis">
      {k.map((x, i) => (
        <button key={x.l} className={`stat ${x.cls}`} style={{ animationDelay: `${i * 40}ms` }} onClick={() => nav(x.go)}>
          <div className="v">{x.v}</div>
          <div className="l">{x.l}</div>
          <div className="kpi-sub">{x.sub}</div>
          {x.spark && <Spark values={x.spark} stretch color={crit ? 'var(--st-critical)' : 'var(--data)'} />}
        </button>
      ))}
    </div>
  );
}

function ReadinessPanel() {
  const r = useOps((s) => s.readiness);
  const info = useOps((s) => s.readinessInfo);
  const can = useSession((s) => s.can);
  const [set, setSet] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const hist = useAsync((s) => get<{ t: number; level: string; reason: string; set_by: string }[]>('/api/ops/readiness/history', s), [r?.t]);
  if (!r) return <Loading />;
  return (
    <section className="panel cmd-ready">
      <div className="panel-h">
        <h3>Readiness</h3>
      </div>
      <div className="ready-row">
        {READINESS_LEVELS.map((l) => (
          <button key={l} className={`ready-step r-${l.replace(' ', '-')} ${r.level === l ? 'on' : ''}`} disabled={!can('ops.readiness') || r.level === l} onClick={() => (setSet(l), setReason(''))} title={info[l]}>
            {l}
          </button>
        ))}
      </div>
      <div className="section">
        <div>{info[r.level]}</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Set {r.t ? dtg(r.t) : '—'} by {r.by}: {r.reason}
        </div>
      </div>
      <div className="section" style={{ maxHeight: 140, overflow: 'auto' }}>
        {(hist.data ?? []).slice(0, 8).map((h, i) => (
          <div key={i} className="mono" style={{ fontSize: 11 }}>
            {dtg(h.t)} <b>{h.level}</b> <span className="dim">{h.set_by} — {h.reason}</span>
          </div>
        ))}
      </div>
      {set && (
        <Modal title={`Set readiness: ${set}`} onClose={() => setSet(null)}>
          <div className="col">
            <div className="note">{info[set]}</div>
            <textarea className="input" rows={3} autoFocus value={reason} placeholder="Reason / authority (recorded in the duty log)" onChange={(e) => setReason(e.target.value)} />
            {err && <ErrorNote error={err} />}
            <div className="row">
              <div className="spacer" />
              <button
                className="btn primary"
                disabled={reason.trim().length < 3}
                onClick={() =>
                  void post('/api/ops/readiness', { level: set, reason })
                    .then(() => setSet(null))
                    .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
                }
              >
                Confirm {set}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

const fmtS = (s: number | null) => (s === null ? '—' : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

function ThreatBoard() {
  const threats = useOps((s) => s.threats);
  const select = useWorld((s) => s.select);
  const flyTo = useWorld((s) => s.flyTo);
  const nav = useNavigate();
  const go = (t: ThreatAssessment) => {
    nav('/operations');
    select({ kind: 'track', id: t.trackId });
    flyTo({ ...t.position, z: Math.max(t.position.z, terrainHeight(t.position.x, t.position.y)) }, 400);
  };
  return (
    <section className="panel cmd-threats">
      <div className="panel-h">
        <h3>Threat evaluation</h3>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 11 }}>
          ranked by proximity, imminence and approach to vital assets — decision support only
        </span>
      </div>
      <div className="scroll" style={{ maxHeight: 360 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Level</th>
              <th>Track</th>
              <th>Threatens</th>
              <th>Range</th>
              <th>Reaches in</th>
              <th>Closing</th>
              <th>CPA</th>
              <th>Grid</th>
            </tr>
          </thead>
          <tbody>
            {threats.slice(0, 25).map((t) => (
              <tr key={t.trackId} className="click" onClick={() => go(t)} title={t.factors.map((f) => `${f.name} ${f.value}`).join(' · ')}>
                <td>
                  <span className={`tlevel ${t.level}`}>{t.level}</span> <span className="mono dim">{t.score}</span>
                </td>
                <td>
                  <b className="mono">{t.label}</b> <span className="dim">{t.classification === 'unknown' ? t.category : t.classification}</span>
                  {t.status !== 'confirmed' && <span className="dim"> ({t.status})</span>}
                </td>
                <td>{t.assetName}</td>
                <td className="mono">{t.inside ? 'INSIDE' : `${t.rangeM} m`}</td>
                <td className="mono">{t.inside ? '—' : fmtS(t.timeToBoundaryS)}</td>
                <td className="mono">{t.closingMps > 0 ? `${t.closingMps} m/s` : 'opening'}</td>
                <td className="mono">{t.tcpaS !== null ? `${t.cpaM} m in ${fmtS(t.tcpaS)}` : '—'}</td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {grid(t.position)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!threats.length && <div className="empty">No non-cooperative tracks near vital assets.</div>}
      </div>
    </section>
  );
}

function TeamsPanel({ version }: { version: number }) {
  const can = useSession((s) => s.can);
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const teams = useAsync((s) => get<Team[]>('/api/ops/teams', s), [version, n]);
  const [dispatch, setDispatch] = useState(false);
  return (
    <section className="panel">
      <div className="panel-h">
        <h3>Response teams</h3>
        <div className="spacer" />
        {can('ops.dispatch') && (
          <button className="btn small" onClick={() => setDispatch(true)}>
            Dispatch to grid…
          </button>
        )}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Callsign</th>
            <th>Type</th>
            <th>Status</th>
            <th>Position</th>
            <th>Net</th>
          </tr>
        </thead>
        <tbody>
          {(teams.data ?? []).map((t) => (
            <tr key={t.id}>
              <td>
                <b className="mono">{t.callsign}</b>
                <div className="dim" style={{ fontSize: 11 }}>
                  {t.leader ?? ''} · {t.strength} pax · {t.mode}
                </div>
              </td>
              <td>{t.kind}</td>
              <td>
                <span className={`tstat ${t.status.replace(' ', '-')}`}>{t.status}</span>
              </td>
              <td className="mono" style={{ fontSize: 11 }}>
                {t.mgrs ?? <span className="dim">no GPS</span>}
                {t.positionAgeS !== null && t.positionAgeS > 60 && <span className="err-inline"> {t.positionAgeS}s old</span>}
              </td>
              <td className="mono">{t.channel ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {dispatch && <DispatchDialog alert={null} onClose={() => setDispatch(false)} />}
    </section>
  );
}

const NEXT: Record<string, string[]> = {
  ISSUED: ['ACKNOWLEDGED', 'EN ROUTE', 'CANCELLED'],
  ACKNOWLEDGED: ['EN ROUTE', 'ON SCENE', 'CANCELLED'],
  'EN ROUTE': ['ON SCENE', 'CANCELLED'],
  'ON SCENE': ['COMPLETE'],
};

function TasksPanel({ version }: { version: number }) {
  const can = useSession((s) => s.can);
  const tasks = useAsync((s) => get<Task[]>('/api/ops/tasks?limit=40', s), [version]);
  const [closing, setClosing] = useState<Task | null>(null);
  const [outcome, setOutcome] = useState('');
  const upd = (t: Task, status: string, out?: string) => void post(`/api/ops/tasks/${t.id}/status`, { status, ...(out ? { outcome: out } : {}) }).then(() => useOps.setState((s) => ({ version: s.version + 1 })));
  return (
    <section className="panel">
      <div className="panel-h">
        <h3>Tasks</h3>
      </div>
      <div className="scroll" style={{ maxHeight: 420 }}>
        {(tasks.data ?? []).map((t) => (
          <div key={t.id} className={`task ${t.status === 'COMPLETE' || t.status === 'CANCELLED' ? 'closed' : ''}`}>
            <div className="row">
              <Prio p={t.priority} />
              <b className="mono">
                #{t.number} {t.callsign}
              </b>
              <span className={`tstat ${t.status.replace(' ', '-')}`}>{t.status}</span>
              <div className="spacer" />
              <span className="mono dim">{dtg(t.createdAt)}</span>
            </div>
            <div style={{ fontSize: 12.5 }}>{t.orders}</div>
            <div className="mono dim" style={{ fontSize: 11 }}>
              {t.mgrs ? `grid ${t.mgrs}` : (t.locationText ?? '')}
              {t.etaS !== null && t.status !== 'COMPLETE' ? ` · ETA ~${Math.ceil(t.etaS / 60)} min from dispatch` : ''}
              {t.outcome ? ` · outcome: ${t.outcome}` : ''}
            </div>
            {can('ops.dispatch') && NEXT[t.status] && (
              <div className="row" style={{ gap: 4 }}>
                {NEXT[t.status]!.map((s) => (
                  <button key={s} className={`btn small ${s === 'CANCELLED' ? 'ghost' : ''}`} onClick={() => (s === 'COMPLETE' ? (setClosing(t), setOutcome('')) : upd(t, s))}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {tasks.data?.length === 0 && <div className="empty">No tasks issued.</div>}
      </div>
      {closing && (
        <Modal title={`Complete task #${closing.number} (${closing.callsign})`} onClose={() => setClosing(null)}>
          <textarea className="input" rows={3} style={{ width: '100%' }} autoFocus placeholder="Outcome as reported by the team" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <div className="spacer" />
            <button className="btn primary" disabled={outcome.trim().length < 3} onClick={() => (upd(closing, 'COMPLETE', outcome), setClosing(null))}>
              Record outcome
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------------------------------------

function DutyLog() {
  const can = useSession((s) => s.can);
  const version = useOps((s) => s.version);
  const [kind, setKind] = useState('');
  const log = useAsync((s) => get<{ id: number; t: number; kind: string; text: string; author: string; ref: string | null }[]>(`/api/ops/log?limit=500${kind ? `&kind=${kind}` : ''}`, s), [version, kind]);
  const [text, setText] = useState('');
  const [k, setK] = useState('manual');
  return (
    <div className="scroll" style={{ padding: 16 }}>
      <div className="col" style={{ maxWidth: 1100, gap: 12 }}>
        {can('ops.log') && (
          <div className="row">
            <select className="input" value={k} onChange={(e) => setK(e.target.value)}>
              {['manual', 'radio', 'visitor', 'patrol', 'correction'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <input className="input grow" value={text} placeholder="New occurrence-book entry (timestamped, append-only)" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim().length > 1 && void post('/api/ops/log', { text, kind: k }).then(() => (setText(''), log.reload()))} />
            <button className="btn primary" disabled={text.trim().length < 2} onClick={() => void post('/api/ops/log', { text, kind: k }).then(() => (setText(''), log.reload()))}>
              Enter
            </button>
          </div>
        )}
        <div className="row">
          <span className="muted">Filter</span>
          <div className="seg">
            {['', 'manual', 'radio', 'readiness', 'dispatch', 'handover', 'report'].map((x) => (
              <button key={x} className={kind === x ? 'on' : ''} onClick={() => setKind(x)}>
                {x ? x.toUpperCase() : 'ALL'}
              </button>
            ))}
          </div>
          <div className="spacer" />
          <span className="muted">Entries cannot be edited or deleted; add a correction instead.</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 130 }}>DTG</th>
              <th style={{ width: 90 }}>Type</th>
              <th>Entry</th>
              <th style={{ width: 110 }}>By</th>
            </tr>
          </thead>
          <tbody>
            {(log.data ?? []).map((l) => (
              <tr key={l.id}>
                <td className="mono">{dtg(l.t)}</td>
                <td className="upper dim">{l.kind}</td>
                <td>{l.text}</td>
                <td>{l.author}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------------------

interface HandoverState {
  readiness: { level: string; reason: string };
  alertsOpen: Record<string, number>;
  alertsAcknowledged: Record<string, number>;
  topAlerts: { id: string; priority: string; title: string; status: string; t: number }[];
  incidents: { id: string; code: string; title: string; status: string }[];
  activeTasks: { id: string; number: number; callsign: string; status: string; orders: string }[];
  teams: { callsign: string; status: string }[];
  sensorFaults: { sensorId: string; status: string; message: string | null }[];
  pendingFaceReviews: number;
  topThreats: { trackId: string; level: string; score: number; assetName: string }[];
}

function HandoverView({ s }: { s: HandoverState }) {
  return (
    <div className="handover">
      <div>
        <b>Readiness</b> {s.readiness.level} — {s.readiness.reason}
      </div>
      <div>
        <b>Alerts open</b> {Object.entries(s.alertsOpen).map(([k, v]) => `${v} ${k}`).join(', ')} · <b>acknowledged</b> {Object.entries(s.alertsAcknowledged).map(([k, v]) => `${v} ${k}`).join(', ')}
      </div>
      <ul>
        {s.topAlerts.map((a) => (
          <li key={a.id}>
            <Prio p={a.priority} /> {a.title} <span className="dim">({a.status}, {dtg(a.t)})</span>
          </li>
        ))}
      </ul>
      <div>
        <b>Open incidents</b> {s.incidents.length ? s.incidents.map((i) => `${i.code} ${i.title} (${i.status})`).join('; ') : 'none'}
      </div>
      <div>
        <b>Active tasks</b> {s.activeTasks.length ? s.activeTasks.map((t) => `#${t.number} ${t.callsign} ${t.status}`).join('; ') : 'none'}
      </div>
      <div>
        <b>Teams</b> {s.teams.map((t) => `${t.callsign} ${t.status}`).join(' · ')}
      </div>
      <div>
        <b>Sensor faults</b> {s.sensorFaults.length ? s.sensorFaults.map((f) => `${f.sensorId} ${f.status}`).join(', ') : 'none'}
      </div>
      <div>
        <b>Pending identity reviews</b> {s.pendingFaceReviews}
      </div>
      <div>
        <b>Top threats</b> {s.topThreats.length ? s.topThreats.map((t) => `${t.trackId} ${t.level} (${t.score}) vs ${t.assetName}`).join('; ') : 'none'}
      </div>
    </div>
  );
}

function Handover() {
  const user = useSession((s) => s.user);
  const can = useSession((s) => s.can);
  const state = useAsync((s) => get<HandoverState>('/api/ops/handover/state', s), []);
  const list = useAsync((s) => get<{ id: string; t: number; outgoing: string; incoming: string; summary: string; state: HandoverState; acknowledged_at: number | null }[]>('/api/ops/handovers', s), []);
  const users = useAsync((s) => (can('admin.users') ? get<{ username: string }[]>('/api/admin/users', s) : Promise.resolve([] as { username: string }[])), []);
  const [incoming, setIncoming] = useState('');
  const [summary, setSummary] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!can('ops.log')) return <div className="empty">Watch handover requires operator rights.</div>;
  return (
    <div className="scroll" style={{ padding: 16 }}>
      <div className="col" style={{ maxWidth: 1100, gap: 16 }}>
        <section className="panel" style={{ padding: 14 }}>
          <h4 className="upper muted" style={{ margin: '0 0 8px' }}>
            Current state (captured into the handover)
          </h4>
          {state.data ? <HandoverView s={state.data} /> : <Loading />}
          <div className="formgrid" style={{ marginTop: 12 }}>
            <label>Incoming officer</label>
            {users.data?.length ? (
              <select className="input" value={incoming} onChange={(e) => setIncoming(e.target.value)}>
                <option value="">— choose —</option>
                {users.data.filter((u) => u.username !== user?.username).map((u) => (
                  <option key={u.username}>{u.username}</option>
                ))}
              </select>
            ) : (
              <input className="input" value={incoming} placeholder="username" onChange={(e) => setIncoming(e.target.value)} />
            )}
            <label>Briefing</label>
            <textarea className="input" rows={4} value={summary} placeholder="Situation, ongoing actions, instructions for the incoming watch" onChange={(e) => setSummary(e.target.value)} />
          </div>
          {err && <ErrorNote error={err} />}
          <div className="row" style={{ marginTop: 8 }}>
            <div className="spacer" />
            <button
              className="btn primary"
              disabled={!incoming || summary.trim().length < 3}
              onClick={() =>
                void post('/api/ops/handovers', { incoming, summary })
                  .then(() => (setSummary(''), list.reload()))
                  .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
              }
            >
              Hand over watch
            </button>
          </div>
        </section>
        {(list.data ?? []).map((h) => (
          <section key={h.id} className="panel" style={{ padding: 14 }}>
            <div className="row">
              <b>
                {h.outgoing} → {h.incoming}
              </b>
              <span className="mono dim">{dtg(h.t)}</span>
              <div className="spacer" />
              {h.acknowledged_at ? (
                <span className="muted">accepted {dtg(h.acknowledged_at)}</span>
              ) : h.incoming === user?.username ? (
                <button className="btn small primary" onClick={() => void post(`/api/ops/handovers/${h.id}/accept`, {}).then(list.reload)}>
                  Accept watch
                </button>
              ) : (
                <span className="err-inline">awaiting {h.incoming}</span>
              )}
            </div>
            <p style={{ margin: '6px 0' }}>{h.summary}</p>
            <details>
              <summary className="muted">State at handover</summary>
              <HandoverView s={h.state} />
            </details>
          </section>
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------------------

interface Sitrep {
  id: string;
  number: number;
  version: number;
  incidentId: string | null;
  periodFrom: number;
  periodTo: number;
  classification: string;
  sections: { key: string; title: string; text: string }[];
  status: 'DRAFT' | 'ISSUED';
  createdBy: string;
  createdAt: number;
  issuedBy: string | null;
  issuedAt: number | null;
  supersedes: string | null;
  dtg: string;
}

function Sitreps() {
  const can = useSession((s) => s.can);
  const incidents = useData((s) => s.incidents);
  const facility = useWorld((s) => s.facility);
  const list = useAsync((s) => get<Sitrep[]>('/api/ops/sitreps', s), []);
  const [sel, setSel] = useState<Sitrep | null>(null);
  const [inc, setInc] = useState('');
  const [hours, setHours] = useState(6);
  const [cls, setCls] = useState('RESTRICTED');
  const [err, setErr] = useState<string | null>(null);
  const draft = () =>
    void post<Sitrep>('/api/ops/sitreps', inc ? { incidentId: inc, classification: cls } : { from: Date.now() - hours * 3600_000, to: Date.now(), classification: cls })
      .then((s) => (setSel(s), list.reload()))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  return (
    <div className="sitrep-layout">
      <div className="scroll" style={{ borderRight: '1px solid var(--line)' }}>
        {can('incidents.edit') && (
          <div className="section col no-print">
            <b className="upper muted">New SITREP</b>
            <select className="input" value={inc} onChange={(e) => setInc(e.target.value)}>
              <option value="">Periodic — last {hours} h</option>
              {incidents.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.code} {i.title}
                </option>
              ))}
            </select>
            {!inc && (
              <label className="row muted">
                Period
                <input className="input" type="number" min={1} max={72} value={hours} onChange={(e) => setHours(Number(e.target.value))} style={{ width: 64 }} />h
              </label>
            )}
            <select className="input" value={cls} onChange={(e) => setCls(e.target.value)}>
              {['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <button className="btn primary" onClick={draft}>
              Draft from record
            </button>
            {err && <ErrorNote error={err} />}
          </div>
        )}
        {(list.data ?? []).map((s) => (
          <div key={s.id} className={`list-row ${sel?.id === s.id ? 'sel' : ''}`} onClick={() => setSel(s)}>
            <div className="grow">
              <b>
                SITREP {s.number}
                {s.version > 1 ? ` AMDT ${s.version - 1}` : ''}
              </b>
              <div className="mono dim" style={{ fontSize: 11 }}>
                {s.dtg} · {s.status} · {s.classification}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="scroll">{sel ? <SitrepEditor key={sel.id} s={sel} site={facility?.name ?? ''} onChanged={(x) => (setSel(x), list.reload())} /> : <div className="empty">Select or draft a SITREP.</div>}</div>
    </div>
  );
}

function SitrepEditor({ s, site, onChanged }: { s: Sitrep; site: string; onChanged: (s: Sitrep) => void }) {
  const can = useSession((st) => st.can);
  const [sections, setSections] = useState(s.sections);
  const [cls, setCls] = useState(s.classification);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editable = s.status === 'DRAFT' && can('incidents.edit');
  const save = () => put<Sitrep>(`/api/ops/sitreps/${s.id}`, { sections, classification: cls }).then((x) => (setDirty(false), onChanged(x)));
  const title = useMemo(() => `SITREP ${s.number}${s.version > 1 ? ` AMDT ${s.version - 1}` : ''}`, [s.number, s.version]);
  return (
    <div className="sitrep">
      <div className="row no-print" style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
        <b>{title}</b>
        <span className={`chip`}>{s.status}</span>
        <div className="spacer" />
        {editable && (
          <button className="btn small" disabled={!dirty} onClick={() => void save().catch((e: unknown) => setErr(String(e)))}>
            Save draft
          </button>
        )}
        {s.status === 'DRAFT' && can('ops.readiness') && (
          <button className="btn small primary" onClick={() => void (dirty ? save() : Promise.resolve()).then(() => post<Sitrep>(`/api/ops/sitreps/${s.id}/issue`, {}).then(onChanged)).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))}>
            Issue
          </button>
        )}
        {s.status === 'ISSUED' && can('incidents.edit') && (
          <button className="btn small" onClick={() => void post<Sitrep>(`/api/ops/sitreps/${s.id}/amend`, {}).then(onChanged)}>
            Amend
          </button>
        )}
        <button className="btn small" onClick={() => window.print()}>
          Print
        </button>
      </div>
      {err && <ErrorNote error={err} />}
      <div className="sitrep-doc">
        <div className="cls-line">{cls}</div>
        <div className="sitrep-head">
          <div>
            <b>{title}</b> {s.status === 'DRAFT' && <span className="dim">(DRAFT — NOT ISSUED)</span>}
          </div>
          <div>DTG {s.dtg}</div>
          <div>FROM: {site}</div>
          <div>
            PERIOD: {dtg(s.periodFrom)} — {dtg(s.periodTo)}
          </div>
          {s.issuedBy && <div>ISSUED BY: {s.issuedBy}</div>}
          {editable && (
            <select className="input no-print" value={cls} onChange={(e) => (setCls(e.target.value), setDirty(true))} style={{ width: 180 }}>
              {['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
        </div>
        {sections.map((sec, i) => (
          <div key={sec.key} className="sitrep-sec">
            <div className="sitrep-title">{sec.title}</div>
            {editable ? (
              <textarea
                className="input"
                rows={Math.min(14, Math.max(2, sec.text.split('\n').length + 1))}
                value={sec.text}
                onChange={(e) => {
                  setSections(sections.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)));
                  setDirty(true);
                }}
              />
            ) : (
              <pre>{sec.text}</pre>
            )}
          </div>
        ))}
        <div className="cls-line">{cls}</div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------------------

function Assets() {
  const can = useSession((s) => s.can);
  const vas = useAsync((s) => get<{ id: string; name: string; kind: string; priority: number; centre: { x: number; y: number }; radiusM: number; zoneId: string | null }[]>('/api/ops/vital-assets', s), []);
  const [edit, setEdit] = useState<{ id: string; name: string; kind: string; priority: number; x: number; y: number; radiusM: number } | null>(null);
  return (
    <div className="scroll" style={{ padding: 16 }}>
      <div className="col" style={{ maxWidth: 1000, gap: 12 }}>
        <div className="note">Vital assets anchor the threat evaluation. Defaults were derived from restricted zones; survey each asset’s centre and protection radius.</div>
        <table className="table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Type</th>
              <th>Priority</th>
              <th>Centre</th>
              <th>Radius</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(vas.data ?? []).map((v) => (
              <tr key={v.id}>
                <td>
                  <b>{v.name}</b>
                  <div className="mono dim">{v.id}</div>
                </td>
                <td>{v.kind}</td>
                <td>P{v.priority}</td>
                <td className="mono">{grid(v.centre)}</td>
                <td className="mono">{v.radiusM} m</td>
                <td>
                  {can('ops.readiness') && (
                    <button className="btn small ghost" onClick={() => setEdit({ id: v.id, name: v.name, kind: v.kind, priority: v.priority, x: v.centre.x, y: v.centre.y, radiusM: v.radiusM })}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {can('ops.readiness') && (
          <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setEdit({ id: '', name: '', kind: 'other', priority: 2, x: 0, y: 0, radiusM: 100 })}>
            + Add asset
          </button>
        )}
      </div>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'Add vital asset'} onClose={() => setEdit(null)}>
          <div className="formgrid">
            <label>Id</label>
            <input className="input" value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value.toLowerCase() })} placeholder="e.g. va-pol-point" />
            <label>Name</label>
            <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <label>Type</label>
            <select className="input" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
              {['ammunition', 'fuel', 'command', 'communications', 'power', 'aircraft', 'accommodation', 'other'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <label>Priority</label>
            <select className="input" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: Number(e.target.value) })}>
              {[1, 2, 3].map((k) => (
                <option key={k} value={k}>
                  P{k}
                </option>
              ))}
            </select>
            <label>Centre (site E, N m)</label>
            <div className="row">
              <input className="input" type="number" value={edit.x} onChange={(e) => setEdit({ ...edit, x: Number(e.target.value) })} />
              <input className="input" type="number" value={edit.y} onChange={(e) => setEdit({ ...edit, y: Number(e.target.value) })} />
              <span className="mono muted">{grid(edit)}</span>
            </div>
            <label>Protection radius (m)</label>
            <input className="input" type="number" value={edit.radiusM} onChange={(e) => setEdit({ ...edit, radiusM: Number(e.target.value) })} />
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <div className="spacer" />
            <button className="btn primary" disabled={!/^[a-z0-9-]{2,40}$/.test(edit.id) || edit.name.length < 2} onClick={() => void put('/api/ops/vital-assets', { ...edit, priority: edit.priority as 1 | 2 | 3 }).then(() => (setEdit(null), vas.reload(), void useOps.getState().load()))}>
              Save (audited)
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
