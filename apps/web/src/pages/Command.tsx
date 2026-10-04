import { ShieldAlert } from 'lucide-react';
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
import { TaskBoard } from '../components/ops/TaskBoard';
import { TacticalScope } from '../components/ops/TacticalScope';
import { Spark } from '../components/charts';
import { useVisionLive } from '../api/vision';
import { useTime } from '../state/time';
import { tracks as trackStore, type RenderTrack } from '../state/tracks';
import { Tabs } from '../components/ui';
import { ActionButton, ActivityHeatmap, Alert, ConfirmMorph, CopyButton, BarChart, Button, ChipGroup, HoldToConfirm, HoverCard, HoverCardProfile, Select as ArcSelect, SignaturePad, SortableDataTable, Textarea, TextMorph, Timeline as ArcTimeline, signatureToPng, useToastStack, type InkStroke } from '../components/kit';
import { OnWatch, useOnWatch } from '../components/ops/OnWatch';
import { MemberSelector } from '../components/vendor/spaceui/components/spaceui/member-selector';
import type { AlertRecord } from '@strata/domain';
import '../styles/command.css';
import { Empty } from '../brand/Boot';

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
        <OnWatch />
        <Tabs
          label="Command views"
          value={tab}
          onChange={(t) => setParams({ tab: t })}
          options={[
            { value: 'OVERVIEW', label: 'Overview' },
            { value: 'DUTY LOG', label: 'Duty log' },
            { value: 'HANDOVER', label: 'Handover' },
            { value: 'SITREP', label: 'SITREP' },
            { value: 'ASSETS', label: 'Assets' },
          ]}
        />
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
        <WatchActivity />
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
  const toast = useToastStack().toast;
  const [set, setSet] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const hist = useAsync((s) => get<{ t: number; level: string; reason: string; set_by: string }[]>('/api/ops/readiness/history', s), [r?.t]);
  if (!r) return <Loading />;
  const raise = (level: string) =>
    post('/api/ops/readiness', { level, reason })
      .then(() => {
        setSet(null);
        toast({ type: level === 'NORMAL' ? 'success' : 'warning', title: `Readiness ${level}`, description: reason });
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  const severe = set === 'HIGH ALERT' || set === 'LOCKDOWN';
  return (
    <section className="panel cmd-ready">
      <div className="panel-h">
        <h3>Readiness</h3>
        <div className="spacer" />
        <span className={`readiness r-${r.level.replace(' ', '-')}`}>
          <TextMorph>{r.level}</TextMorph>
        </span>
      </div>
      <div className="ready-row">
        {READINESS_LEVELS.map((l) => (
          <button key={l} className={`ready-step r-${l.replace(' ', '-')} ${r.level === l ? 'on' : ''}`} disabled={!can('ops.readiness') || r.level === l} onClick={() => (setSet(l), setReason(''), setErr(null))} title={info[l]}>
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
      <div className="ready-hist">
        <ArcTimeline
          label="Readiness history"
          now={Date.now()}
          maxHeight={220}
          events={(hist.data ?? []).slice(0, 12).map((h, i) => ({ id: `${h.t}-${i}`, at: h.t, title: h.level, actor: h.set_by, meta: h.reason, tone: h.level === 'NORMAL' ? 'success' : h.level === 'LOCKDOWN' || h.level === 'HIGH ALERT' ? 'danger' : 'neutral' }))}
        />
      </div>
      {set && (
        <Modal title={`Set readiness: ${set}`} onClose={() => setSet(null)}>
          <div className="col" style={{ gap: 14 }}>
            <Alert tone={severe ? 'danger' : set === 'ALERT' ? 'warning' : 'info'} title={set}>
              {info[set]}
            </Alert>
            <Textarea label="Reason and authority" description="Recorded in the duty log and the audit trail." rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
            {err && <ErrorNote error={err} />}
            <div className="row">
              <div className="spacer" />
              {severe ? (
                <HoldToConfirm icon={<ShieldAlert size={16} />} label={`Hold to set ${set}`} confirmedLabel={`${set} set`} tone="danger" duration={1500} disabled={reason.trim().length < 3} onConfirm={() => void raise(set)} />
              ) : (
                <Button variant="primary" disabled={reason.trim().length < 3} onClick={() => void raise(set)}>
                  Set {set}
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** The watch over time: alerts per day (Arc activity heatmap) and what raised them (Arc bar chart). */
function WatchActivity() {
  const [day, setDay] = useState<string | null>(null);
  const from = useMemo(() => Date.now() - 26 * 7 * 86_400_000, []);
  const hist = useAsync((s) => get<AlertRecord[]>(`/api/alerts?from=${from}&limit=2000`, s), [from]);
  const days = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of hist.data ?? []) {
      const d = new Date(a.t).toISOString().slice(0, 10);
      m.set(d, (m.get(d) ?? 0) + 1);
    }
    // Every day of the period, so quiet days show as empty cells rather than gaps.
    const out: { date: string; count: number }[] = [];
    for (let t = from; t <= Date.now(); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      out.push({ date: d, count: m.get(d) ?? 0 });
    }
    return out;
  }, [hist.data, from]);
  const rules = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of hist.data ?? []) if (!day || new Date(a.t).toISOString().slice(0, 10) === day) m.set(a.rule, (m.get(a.rule) ?? 0) + 1);
    return [...m.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 8)
      .map(([k, v]) => {
        const words = k.toLowerCase().split('_');
        const tail = words.length > 1 ? words.slice(1).join(' ') : words[0]!;
        return { key: k, label: k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, ' '), axisLabel: tail.charAt(0).toUpperCase() + tail.slice(1, 10), value: v };
      });
  }, [hist.data, day]);
  if (!hist.data) return <section className="panel cmd-activity"><Loading what="alert history" /></section>;
  return (
    <section className="panel cmd-activity">
      <div className="panel-h">
        <h3>Watch activity</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {hist.data.length} alerts in 26 weeks
        </span>
      </div>
      {hist.data.length === 0 ? (
        <Empty compact art="sensors" title="No alerts recorded yet" description="Alerts raised by rules and reports appear here by day." />
      ) : (
        <div className="cmd-activity-body">
          <ActivityHeatmap days={days} label="Alerts per day" period="Last 26 weeks" unit={{ one: 'alert', other: 'alerts' }} thresholds={[1, 4, 10]} weekStartsOn={1} selectedDate={day} onSelectDate={(d) => setDay(d === day ? null : d)} />
          <BarChart data={rules} label="Alerts by rule" period={day ? `On ${day}` : 'Last 26 weeks'} unit="alerts" valueLabel="Alerts" categoryLabel="Rule" averageLabel="Average per rule" height={150} />
        </div>
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
                <HoverCard
                  side="right"
                  content={
                    <HoverCardProfile
                      name={t.callsign}
                      role={`${t.kind} · ${t.mode}`}
                      bio={t.leader ? `Leader: ${t.leader}` : undefined}
                      stats={[
                        { label: 'Strength', value: t.strength },
                        { label: 'Status', value: t.status },
                        { label: 'Net', value: t.channel ?? '—' },
                      ]}
                      meta={t.mgrs ? `${t.mgrs}${t.positionAgeS !== null ? ` · fix ${t.positionAgeS}s ago` : ''}` : 'No position fix'}
                    />
                  }
                >
                  <button className="link-btn mono">{t.callsign}</button>
                </HoverCard>
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

function TasksPanel({ version }: { version: number }) {
  const can = useSession((s) => s.can);
  const tasks = useAsync((s) => get<Task[]>('/api/ops/tasks?limit=60', s), [version]);
  return (
    <section className="panel tasks-panel">
      <div className="panel-h">
        <h3>Tasks</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {can('ops.dispatch') ? 'Drag a card to record its progress' : 'Read only'}
        </span>
      </div>
      {tasks.data && tasks.data.length === 0 ? <Empty compact art="tasks" title="No tasks issued" description="Dispatch a team to an alert, a track or a grid reference to create one." /> : <TaskBoard tasks={tasks.data ?? []} canDispatch={can('ops.dispatch')} />}
    </section>
  );
}

// -----------------------------------------------------------------------------------------------------------

const LOG_KINDS = ['manual', 'radio', 'visitor', 'patrol', 'correction'];

function DutyLog() {
  const can = useSession((s) => s.can);
  const version = useOps((s) => s.version);
  const [kinds, setKinds] = useState<string[]>([]);
  const log = useAsync((s) => get<{ id: number; t: number; kind: string; text: string; author: string; ref: string | null }[]>(`/api/ops/log?limit=500${kinds.length === 1 ? `&kind=${kinds[0]}` : ''}`, s), [version, kinds.join()]);
  const [text, setText] = useState('');
  const [k, setK] = useState('manual');
  const toast = useToastStack().toast;
  const add = () =>
    post('/api/ops/log', { text, kind: k })
      .then(() => {
        setText('');
        log.reload();
        toast({ type: 'success', title: 'Entry recorded', description: `${k} · ${dtg(Date.now())}` });
      })
      .catch((e: unknown) => toast({ type: 'error', title: 'Not recorded', description: e instanceof Error ? e.message : String(e) }));
  const rows = (log.data ?? []).filter((l) => !kinds.length || kinds.includes(l.kind));
  return (
    <div className="scroll" style={{ padding: 20 }}>
      <div className="col" style={{ maxWidth: 1000, gap: 16 }}>
        {can('ops.log') && (
          <section className="panel duty-new">
            <div className="duty-new-row">
              <div style={{ width: 170 }}>
                <ArcSelect label="Type" value={k} onValueChange={setK} options={LOG_KINDS.map((x) => ({ value: x, label: x.charAt(0).toUpperCase() + x.slice(1) }))} />
              </div>
              <div className="grow">
                <Textarea
                  label="New entry"
                  description="Timestamped and append-only. Ctrl Enter to record."
                  rows={2}
                  value={text}
                  placeholder="What happened, who, where (grid reference), what was done"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && text.trim().length > 1 && void add()}
                />
              </div>
            </div>
            <div className="row">
              <span className="spacer" />
              <Button variant="primary" disabled={text.trim().length < 2} onClick={() => void add()}>
                Record entry
              </Button>
            </div>
          </section>
        )}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <ChipGroup label="Entry types" value={kinds} onValueChange={setKinds} options={['manual', 'radio', 'readiness', 'dispatch', 'handover', 'report', 'patrol', 'visitor', 'correction'].map((x) => ({ value: x, label: x.charAt(0).toUpperCase() + x.slice(1) }))} />
          <div className="spacer" />
          <span className="muted" style={{ fontSize: 12 }}>
            Entries cannot be edited or deleted; add a correction instead.
          </span>
        </div>
        {log.data && rows.length === 0 ? (
          <Empty compact art="audit" title="No entries" description="Nothing has been recorded with these types yet." />
        ) : (
          <ArcTimeline label="Duty log" now={Date.now()} events={rows.map((l) => ({ id: String(l.id), at: l.t, title: l.text, actor: l.author, meta: `${l.kind.toUpperCase()} · ${dtg(l.t)}${l.ref ? ` · ${l.ref}` : ''}`, tone: l.kind === 'correction' ? 'danger' : l.kind === 'handover' ? 'success' : 'neutral' }))} />
        )}
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
  const list = useAsync((s) => get<{ id: string; t: number; outgoing: string; incoming: string; summary: string; state: HandoverState; acknowledged_at: number | null; signature: string | null }[]>('/api/ops/handovers', s), []);
  const [signing, setSigning] = useState<string | null>(null);
  const users = useAsync((s) => (can('admin.users') ? get<{ username: string; displayName: string; disabled: boolean }[]>('/api/admin/users', s) : Promise.resolve([] as { username: string; displayName: string; disabled: boolean }[])), []);
  const online = useOnWatch();
  const members = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; name: string; email?: string }[] = [];
    const add = (id: string, name: string, email: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, name, email });
    };
    for (const o of online) add(o.username, o.displayName, `${o.role} · on watch`);
    for (const u of users.data ?? []) if (!u.disabled) add(u.username, u.displayName, u.username);
    return out;
  }, [online, users.data]);
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
          <div className="handover-form">
            <div className="col" style={{ gap: 6 }}>
              <span className="setup-label">Incoming officer</span>
              <MemberSelector
                label="Incoming officer"
                max={1}
                maxVisible={6}
                members={members.filter((m) => m.id !== user?.username)}
                selected={incoming ? [incoming] : []}
                onChange={(sel: string[]) => setIncoming(sel[sel.length - 1] ?? '')}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                {incoming ? `${incoming} signs to accept the watch.` : 'Choose who takes over. Officers on watch are listed first.'}
              </span>
            </div>
            <Textarea label="Briefing" description="Situation, ongoing actions, instructions for the incoming watch." rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
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
        {signing && <SignHandover id={signing} name={user?.displayName ?? ''} onClose={() => setSigning(null)} onDone={() => (setSigning(null), list.reload())} />}
        {(list.data ?? []).map((h) => (
          <section key={h.id} className="panel" style={{ padding: 14 }}>
            <div className="row">
              <b>
                {h.outgoing} → {h.incoming}
              </b>
              <span className="mono dim">{dtg(h.t)}</span>
              <div className="spacer" />
              {h.acknowledged_at ? (
                <span className="row muted" style={{ gap: 8 }}>
                  {h.signature && <img className="sig-thumb" src={h.signature} alt={`Signature of ${h.incoming}`} />}
                  accepted {dtg(h.acknowledged_at)}
                </span>
              ) : h.incoming === user?.username ? (
                <Button size="sm" variant="primary" onClick={() => setSigning(h.id)}>
                  Accept and sign
                </Button>
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

/** Taking over the watch: the incoming officer signs (Arc signature pad); the PNG and its hash are kept. */
function SignHandover({ id, name, onClose, onDone }: { id: string; name: string; onClose: () => void; onDone: () => void }) {
  const [strokes, setStrokes] = useState<InkStroke[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToastStack().toast;
  const accept = async () => {
    setErr(null);
    try {
      const blob = await signatureToPng(strokes, 2);
      const signature = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(blob);
      });
      await post(`/api/ops/handovers/${id}/accept`, { signature });
      toast({ type: 'success', title: 'You have the watch', description: 'Handover signed and recorded.' });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal title="Take over the watch" onClose={onClose} wide>
      <div className="col" style={{ gap: 12 }}>
        <span className="muted">Sign to confirm you have read the briefing and the state captured at handover. The signature and its SHA-256 are stored with the handover and the audit record.</span>
        <div className="sig-pad">
          <SignaturePad signer={name} hint="Sign here" label="Handover signature" onChange={setStrokes} fileName="handover-signature" />
        </div>
        {err && <ErrorNote error={err} />}
        <div className="row">
          <span className="spacer" />
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!strokes.length} onClick={() => void accept()}>
            Accept the watch
          </Button>
        </div>
      </div>
    </Modal>
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
      <div className="scroll">{sel ? <SitrepEditor key={sel.id} s={sel} site={facility?.name ?? ''} onChanged={(x) => (setSel(x), list.reload())} /> : <Empty art="audit" title="Select or draft a SITREP" description="Draft from the record fills the DTG, grid references, alerts, incidents, teams and top threats. Edit, then issue; amendments are kept as versions." />}</div>
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
        {editable && <ActionButton label="Save draft" pendingLabel="Saving" successLabel="Saved" disabled={!dirty} onAction={() => save().then(() => undefined)} onActionError={(e) => setErr(String(e))} />}
        {s.status === 'DRAFT' && can('ops.readiness') && (
          <ConfirmMorph
            label="Issue"
            prompt={`Issue ${title}?`}
            confirmLabel="Issue"
            pendingLabel="Issuing"
            doneLabel="Issued"
            tone="neutral"
            onConfirm={() =>
              (dirty ? save() : Promise.resolve())
                .then(() => post<Sitrep>(`/api/ops/sitreps/${s.id}/issue`, {}))
                .then(onChanged)
                .catch((e: unknown) => {
                  setErr(e instanceof Error ? e.message : String(e));
                  throw e;
                })
            }
          />
        )}
        {s.status === 'ISSUED' && can('incidents.edit') && (
          <button className="btn small" onClick={() => void post<Sitrep>(`/api/ops/sitreps/${s.id}/amend`, {}).then(onChanged)}>
            Amend
          </button>
        )}
        <CopyButton label="Copy text" value={[cls, `${title}${s.status === 'DRAFT' ? ' (DRAFT)' : ''}`, `DTG ${s.dtg}`, `FROM: ${site}`, `PERIOD: ${dtg(s.periodFrom)} - ${dtg(s.periodTo)}`, ...sections.flatMap((x, i) => [`${i + 1}. ${x.title.toUpperCase()}`, x.text]), cls].join('\n')} />
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
        {vas.data && vas.data.length === 0 ? (
          <Empty compact art="site" title="No vital assets" description="Add the places the threat evaluation must protect: armoury, fuel point, ops room, substation." />
        ) : (
          <SortableDataTable
            caption="Vital assets"
            rowKey="id"
            itemName={{ one: 'asset', other: 'assets' }}
            defaultSort={{ key: 'priority', direction: 'asc' }}
            rows={(vas.data ?? []).map((v) => ({ id: v.id, name: v.name, kind: v.kind, priority: v.priority, grid: grid(v.centre), radiusM: v.radiusM, raw: v }))}
            columns={[
              { key: 'name', label: 'Asset', sortable: true, render: (_v, r) => (<span><b>{String(r.name)}</b><span className="mono dim" style={{ display: 'block', fontSize: 11 }}>{String(r.id)}</span></span>) },
              { key: 'kind', label: 'Type', sortable: true },
              { key: 'priority', label: 'Priority', sortable: true, numeric: true, render: (v) => `P${String(v)}` },
              { key: 'grid', label: 'Centre', render: (v) => <span className="mono">{String(v)}</span> },
              { key: 'radiusM', label: 'Radius', sortable: true, numeric: true, render: (v) => `${String(v)} m` },
              {
                key: 'raw',
                label: '',
                render: (_v, r) => {
                  const v = r.raw as { id: string; name: string; kind: string; priority: number; centre: { x: number; y: number }; radiusM: number };
                  return can('ops.readiness') ? (
                    <button className="btn small ghost" onClick={() => setEdit({ id: v.id, name: v.name, kind: v.kind, priority: v.priority, x: v.centre.x, y: v.centre.y, radiusM: v.radiusM })}>
                      Edit
                    </button>
                  ) : null;
                },
              },
            ]}
          />
        )}
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
