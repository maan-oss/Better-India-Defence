import { useEffect, useMemo, useState } from 'react';
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
import { dtg } from '@strata/domain';
import { Button, ChipGroup, CommentThread, DatePicker, InlineEdit, Input, NumberField, SearchField, SegmentedControl, SortableDataTable, Tabs, TabsContent, TabsList, TabsTrigger, TimePicker, useToastStack, type ThreadComment } from '../components/kit';
import { Timeline as SuiTimeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from '../components/vendor/spaceui/components/spaceui/timeline';
import { Empty } from '../brand/Boot';

const STATUS_FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'closed', label: 'Closed' },
];

/** INCIDENTS — investigation library and incident files. */
export function Incidents() {
  const { id } = useParams();
  const incidents = useData((s) => s.incidents);
  const nav = useNavigate();
  const can = useSession((s) => s.can);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [statuses, setStatuses] = useState<string[]>([]);
  useEffect(() => {
    void useData.getState().loadInitial();
  }, []);
  // Open the most recent incident rather than an empty pane.
  useEffect(() => {
    if (!id && !creating && incidents[0]) nav(`/incidents/${incidents[0].id}`, { replace: true });
  }, [id, creating, incidents, nav]);
  const shown = useMemo(
    () => incidents.filter((i) => (!statuses.length || statuses.includes(i.status)) && (!q || `${i.code} ${i.title}`.toLowerCase().includes(q.toLowerCase()))),
    [incidents, statuses, q],
  );
  return (
    <div className="page">
      <div className="page-h">
        <h1>Incidents</h1>
        <span className="sub">Investigations anchored in space and time. Evidence is gathered automatically from the incident window.</span>
        <div className="spacer" />
        {can('incidents.create') && (
          <Button variant={creating ? 'ghost' : 'primary'} onClick={() => setCreating((c) => !c)}>
            {creating ? 'Cancel' : 'New incident'}
          </Button>
        )}
      </div>
      <div className="page-body split">
        <div className="scroll inc-list">
          {incidents.length > 0 && (
            <div className="inc-filters">
              <SearchField label="Find incident" placeholder="Code or title" value={q} onValueChange={setQ} />
              <ChipGroup label="Status" options={STATUS_FILTERS} value={statuses} onValueChange={setStatuses} />
            </div>
          )}
          {incidents.length === 0 && (
            <Empty compact art="incidents" title="No incidents recorded" description="Critical alerts open an incident automatically. Operators can also open one for any place and time window." />
          )}
          {incidents.length > 0 && shown.length === 0 && <Empty compact art="search" title="No incident matches" description="Clear the search or the status filter." />}
          {shown.map((i) => (
            <button key={i.id} className={`list-row inc-row ${i.id === id || i.code === id ? 'sel' : ''}`} onClick={() => (setCreating(false), nav(`/incidents/${i.id}`))}>
              <div className={`inc-sev s-${i.status}`} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="mono" style={{ color: 'var(--accent-2)', fontSize: 11.5 }}>
                    {i.code}
                  </span>
                  <span className={`chip ${i.status === 'open' ? 'red' : i.status === 'closed' ? '' : 'amber'}`}>{i.status}</span>
                </div>
                <div className="ellipsis" style={{ fontSize: 13.5, margin: '3px 0 2px' }}>
                  {i.title}
                </div>
                <div className="muted mono" style={{ fontSize: 10.5 }}>
                  {dateTime(i.tStart)} · {dur(i.tEnd - i.tStart)} · {i.alertIds.length} alert(s)
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="scroll">{creating ? <CreateIncident onDone={(nid) => (setCreating(false), nid && nav(`/incidents/${nid}`))} /> : id ? <IncidentFile id={id} /> : <Empty art="incidents" title="Select an incident" description="Its file holds the window, the evidence gathered from every sensor, the tracks, alerts, chronology and pinned items." />}</div>
      </div>
    </div>
  );
}

function IncidentFile({ id }: { id: string }) {
  const { data, error, reload } = useAsync((s) => get<IncidentPackage>(`/api/incidents/${encodeURIComponent(id)}`, s), [id]);
  const nav = useNavigate();
  const can = useSession((s) => s.can);
  const { toast } = useToastStack();
  const [tab, setTab] = useState('file');
  const [exporting, setExporting] = useState(false);
  const notes = useIncidentNotes(data?.incident.id ?? null);
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
  const save = async (body: Partial<Pick<IncidentRecord, 'status' | 'summary' | 'title'>>, what: string) => {
    try {
      await patch(`/api/incidents/${inc.id}`, body);
      reload();
      void useData.getState().loadInitial();
      toast({ type: 'success', title: `${what} saved`, description: inc.code });
    } catch (e) {
      toast({ type: 'error', title: `${what} not saved`, description: e instanceof Error ? e.message : 'failed' });
      throw e;
    }
  };
  const exportFile = async () => {
    setExporting(true);
    try {
      const res = await fetch(`/api/incidents/${inc.id}/export`, { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`export failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${inc.code}.json`;
      a.click();
      toast({ type: 'success', title: 'Evidence package exported', description: `${inc.code}.json · the export is recorded in the audit log` });
    } catch (e) {
      toast({ type: 'error', title: 'Export failed', description: e instanceof Error ? e.message : 'failed' });
    } finally {
      setExporting(false);
    }
  };
  const edit = can('incidents.edit');
  return (
    <div className="reveal inc-file">
      <div className="section">
        <div className="upper muted">
          {inc.code} · created by {inc.createdBy}
        </div>
        {edit ? (
          <InlineEdit as="h2" className="inc-title" label="Incident title" value={inc.title} validate={(v) => (v.trim().length < 3 ? 'At least 3 characters' : v.length > 160 ? 'At most 160 characters' : null)} onSave={(v) => save({ title: v.trim() }, 'Title')} />
        ) : (
          <h2 className="inc-title">{inc.title}</h2>
        )}
        <div className="mono muted" style={{ fontSize: 12 }}>
          {dateTime(inc.tStart)} → {hms(inc.tEnd)}Z · centre E {inc.center.x.toFixed(0)} N {inc.center.y.toFixed(0)} · radius {Math.round(inc.radiusM)} m
        </div>
        <div className="inc-actions">
          <Button onClick={enter}>Enter reconstruction environment</Button>
          {can('evidence.export') && (
            <Button variant="secondary" loading={exporting} onClick={() => void exportFile()}>
              Export evidence package
            </Button>
          )}
          <div className="spacer" />
          {edit ? (
            <SegmentedControl label="Incident status" value={inc.status} onValueChange={(s) => void save({ status: s as IncidentRecord['status'] }, 'Status').catch(() => undefined)} options={STATUS_FILTERS} />
          ) : (
            <span className="chip">{inc.status}</span>
          )}
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab} className="inc-tabs">
        <TabsList aria-label="Incident file">
          <TabsTrigger value="file">File</TabsTrigger>
          <TabsTrigger value="evidence">Evidence · {data.sensors.length}</TabsTrigger>
          <TabsTrigger value="tracks">Tracks and alerts · {data.tracks.length + data.alerts.length}</TabsTrigger>
          <TabsTrigger value="notes">Notes · {notes.items.length}</TabsTrigger>
        </TabsList>
        <TabsContent value="file">
          <div className="section">
            <h4>Summary</h4>
            {edit ? (
              <InlineEdit multiline variant="body" as="p" label="Incident summary" placeholder="What is known, what is not, and what is being done." value={inc.summary ?? ''} validate={(v) => (v.length > 4000 ? 'At most 4000 characters' : null)} onSave={(v) => save({ summary: v }, 'Summary')} />
            ) : (
              <p>{inc.summary || <span className="muted">No summary.</span>}</p>
            )}
          </div>
          <Chronology data={data} />
        </TabsContent>
        <TabsContent value="evidence">
          {data.stoppedBefore.length > 0 && (
            <div className="section">
              <h4>Sensors not reporting at incident start</h4>
              <SortableDataTable
                caption="Sensors not reporting"
                rowKey="key"
                itemName={{ one: 'sensor', other: 'sensors' }}
                rows={data.stoppedBefore.map((s) => ({ key: s.sensorId + s.t, sensor: s.sensorId, status: s.status, from: s.t, restored: s.restoredAt ?? 0 }))}
                columns={[
                  { key: 'sensor', label: 'Sensor', sortable: true, render: (v) => <span className="mono">{String(v)}</span> },
                  { key: 'status', label: 'Status', sortable: true },
                  { key: 'from', label: 'From', sortable: true, render: (v) => <span className="mono">{hms(Number(v))}Z</span> },
                  { key: 'restored', label: 'Restored', sortable: true, render: (v) => <span className="mono muted">{v ? `${hms(Number(v))}Z` : 'not restored'}</span> },
                ]}
              />
            </div>
          )}
          <div className="section">
            <h4>Gathered from the window</h4>
            <SortableDataTable
              caption="Evidence by sensor"
              rowKey="sensor"
              itemName={{ one: 'sensor', other: 'sensors' }}
              emptyMessage="No sensor saw the incident area in the window"
              defaultSort={{ key: 'obs', direction: 'desc' }}
              rows={data.sensors.map((s) => ({ sensor: s.sensorId, kind: s.kind, reason: s.reason, obs: s.observations, first: s.firstT ?? 0, last: s.lastT ?? 0 }))}
              columns={[
                { key: 'sensor', label: 'Sensor', sortable: true, width: 80, render: (v) => <span className="mono">{String(v)}</span> },
                { key: 'kind', label: 'Kind', sortable: true, width: 80 },
                { key: 'reason', label: 'Why included', render: (v) => <span className="muted">{String(v)}</span> },
                { key: 'obs', label: 'Obs.', sortable: true, numeric: true, width: 70 },
                { key: 'first', label: 'Window', sortable: true, width: 150, render: (v, r) => <span className="mono muted">{v ? `${hms(Number(v))}–${hms(Number(r.last))}` : '—'}</span> },
              ]}
            />
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
        </TabsContent>
        <TabsContent value="tracks">
          <div className="section">
            <h4>Alerts</h4>
            {data.alerts.length === 0 && <div className="muted">No alerts in the window.</div>}
            {data.alerts.map((a) => (
              <div key={a.id} className="row" style={{ padding: '4px 0' }}>
                <Prio p={a.priority} /> <span className="mono muted">{hms(a.t)}Z</span> {a.title}
              </div>
            ))}
          </div>
          <div className="section">
            <h4>Tracks</h4>
            <SortableDataTable
              caption="Tracks in the window"
              rowKey="id"
              itemName={{ one: 'track', other: 'tracks' }}
              emptyMessage="No tracks in the window"
              defaultSort={{ key: 'closest', direction: 'asc' }}
              rows={data.tracks.map((t) => ({ id: t.id, what: t.cooperative ? t.label : t.category, first: t.firstT, last: t.lastT, closest: t.minDistanceM }))}
              columns={[
                { key: 'id', label: 'Track', sortable: true, render: (v) => <span className="mono">{String(v)}</span> },
                { key: 'what', label: 'Identity', sortable: true },
                { key: 'first', label: 'Seen', sortable: true, render: (v, r) => <span className="mono muted">{hms(Number(v))}–{hms(Number(r.last))}</span> },
                { key: 'closest', label: 'Closest', sortable: true, numeric: true, render: (v) => `${String(v)} m` },
              ]}
            />
          </div>
        </TabsContent>
        <TabsContent value="notes">
          <div className="section">
            <p className="muted" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
              Notes are entries in the duty log, referenced to {inc.code}. Like the log, they cannot be edited or deleted; record a correction instead.
            </p>
            {notes.error && <ErrorNote error={notes.error} />}
            <CommentThread
              appendOnly
              title={`Notes on ${inc.code}`}
              currentUser={notes.me}
              comments={notes.items}
              placeholder={can('ops.log') ? 'Add a note to the record' : 'Operator rights are needed to add notes'}
              labels={{ empty: 'No notes yet.', send: 'Record', commentCount: (n) => `${n} note${n === 1 ? '' : 's'}` }}
              onCommentsChange={(_, ev) => {
                if (ev.type === 'reply' && can('ops.log')) void notes.add(ev.comment.body).catch((e: unknown) => toast({ type: 'error', title: 'Note not recorded', description: e instanceof Error ? e.message : 'failed' }));
              }}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface LogRow {
  id: number;
  t: number;
  kind: string;
  text: string;
  author: string;
  ref: string | null;
}

/** Incident notes live in the append-only duty log with `ref` set to the incident id. */
function useIncidentNotes(ref: string | null) {
  const user = useSession((s) => s.user);
  const [version, setVersion] = useState(0);
  const { data, error } = useAsync((s) => (ref ? get<LogRow[]>(`/api/ops/log?ref=${encodeURIComponent(ref)}&limit=500`, s) : Promise.resolve([] as LogRow[])), [ref, version]);
  const items: ThreadComment[] = useMemo(
    () =>
      [...(data ?? [])]
        .sort((a, b) => a.t - b.t)
        .map((l) => ({ id: String(l.id), author: { id: `log:${l.author}`, name: l.author }, body: l.kind === 'manual' ? l.text : `${l.kind.toUpperCase()} · ${l.text}`, createdAt: `${dtg(l.t)}` })),
    [data],
  );
  // The composer's author id never matches a stored note, so recorded notes are never editable.
  const me = { id: `composer:${user?.username ?? 'me'}`, name: user?.displayName ?? user?.username ?? 'You' };
  const add = async (text: string) => {
    if (!ref) return;
    await post('/api/ops/log', { text, kind: 'manual', ref });
    setVersion((v) => v + 1);
  };
  return { items, error, me, add };
}

function CreateIncident({ onDone }: { onDone: (id: string | null) => void }) {
  const t0 = useTime.getState();
  const start = new Date(t0.mode === 'live' ? t0.currentLiveEdge() : t0.t);
  const { toast } = useToastStack();
  const [title, setTitle] = useState('');
  const [day, setDay] = useState<Date | undefined>(new Date(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const [time, setTime] = useState(`${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`);
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
  const [r, setR] = useState(300);
  const [before, setBefore] = useState(5);
  const [after, setAfter] = useState(15);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!day) return;
    const [hh, mm] = time.split(':').map(Number);
    const t = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm);
    setBusy(true);
    try {
      const inc = await post<{ id: string; code?: string }>('/api/incidents', { title: title.trim(), t, x, y, radiusM: r, beforeMin: before, afterMin: after });
      toast({ type: 'success', title: 'Incident opened', description: `Evidence is being gathered from ${before} min before to ${after} min after.` });
      void useData.getState().loadInitial();
      onDone(inc.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="section inc-create reveal">
      <div>
        <h3>New incident</h3>
        <p className="muted">An incident is a place and a time window. Everything every sensor recorded inside it is gathered into the file and preserved.</p>
      </div>
      <Input label="Title" placeholder="e.g. Fence alarm, east segment" value={title} onChange={(e) => setTitle(e.target.value)} error={title && title.trim().length < 3 ? 'At least 3 characters' : undefined} />
      <div className="inc-create-grid">
        <DatePicker label="Date (UTC)" value={day} onChange={setDay} maxDate={new Date()} />
        <TimePicker label="Time (UTC)" value={time} onChange={setTime} format="24h" minuteStep={1} />
        <NumberField label="Before" value={before} onValueChange={setBefore} min={0} max={120} step={1} suffix=" min" />
        <NumberField label="After" value={after} onValueChange={setAfter} min={0} max={240} step={5} suffix=" min" />
        <NumberField label="East" value={x} onValueChange={setX} min={-5000} max={5000} step={10} largeStep={100} suffix=" m" />
        <NumberField label="North" value={y} onValueChange={setY} min={-5000} max={5000} step={10} largeStep={100} suffix=" m" />
        <NumberField label="Radius" value={r} onValueChange={setR} min={20} max={3000} step={10} largeStep={100} suffix=" m" />
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Faster from the map: in Operations, right-click a location and choose “Open incident here”.
      </div>
      {err && <div className="note warn">{err}</div>}
      <div className="row">
        <Button disabled={title.trim().length < 3 || !day} loading={busy} onClick={() => void submit()}>
          Open incident
        </Button>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Everything in the incident window in time order (Space UI timeline): sensor outages, alerts, tracks and pins. */
function Chronology({ data }: { data: IncidentPackage }) {
  const inc = data.incident;
  type Ev = { t: number; tone: 'crit' | 'warn' | 'info' | 'mute'; title: string; detail: string };
  const ev: Ev[] = (
    [
    { t: inc.tStart, tone: 'info' as const, title: 'Incident window opens', detail: inc.title },
    ...data.stoppedBefore.map((s) => ({ t: s.t, tone: 'warn' as const, title: `${s.sensorId} ${s.status}`, detail: s.restoredAt ? `restored ${hms(s.restoredAt)}Z` : 'not restored in the window' })),
    ...data.alerts.map((a) => ({ t: a.t, tone: a.priority === 'critical' || a.priority === 'high' ? ('crit' as const) : ('warn' as const), title: a.title, detail: `${a.priority} alert` })),
    ...data.tracks.map((t) => ({ t: t.firstT, tone: 'mute' as const, title: `Track ${t.id} first seen`, detail: `${t.cooperative ? t.label : t.category} · closest ${t.minDistanceM} m` })),
    { t: inc.tEnd, tone: 'info' as const, title: 'Incident window closes', detail: inc.status },
    ] as Ev[]
  ).sort((a, b) => a.t - b.t);
  const shown = ev.slice(0, 40);
  return (
    <div className="section">
      <h4>Chronology</h4>
      <SuiTimeline value={shown.length} className="inc-chrono">
        {shown.map((e, i) => (
          <TimelineItem key={i} step={i + 1} className={`chr-${e.tone}`}>
            <TimelineHeader>
              <TimelineSeparator />
              <TimelineDate className="mono">{hms(e.t)}Z</TimelineDate>
              <TimelineTitle>{e.title}</TimelineTitle>
              <TimelineIndicator />
            </TimelineHeader>
            <TimelineContent>{e.detail}</TimelineContent>
          </TimelineItem>
        ))}
      </SuiTimeline>
      {ev.length > shown.length && <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>{ev.length - shown.length} more events in the tables below.</div>}
    </div>
  );
}
