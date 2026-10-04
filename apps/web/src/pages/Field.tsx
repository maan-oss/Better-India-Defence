import { useEffect, useMemo, useRef, useState } from 'react';
import type { AlertRecord, Vec3 } from '@strata/domain';
import { get, post } from '../api/client';
import { useData } from '../state/data';
import { useOps, grid } from '../state/ops';
import { useSession } from '../state/session';
import { useTime } from '../state/time';
import { tracks as trackStore, type RenderTrack } from '../state/tracks';
import { symbolFor, symbolTexture } from '../engine/symbols';
import { ErrorNote, Modal, useAsync } from '../components/common';
import type { Task, Team } from '../components/ops/OpsWidgets';
import { Bell, Radio, Siren } from 'lucide-react';
import { Button, HoldToConfirm, Input, Select as ArcSelect, Stepper, SwipeActions, SwipeActionsRow, Switch, Textarea, useToastStack } from '../components/kit';
import { SlideToConfirm } from '../components/vendor/spaceui/components/spaceui/slide-to-confirm';
import { InteractiveChecklist, type ChecklistItem } from '../components/vendor/spaceui/components/spaceui/interactive-checklist';
import { alpha, P as C } from '../lib/palette';
import '../styles/field.css';
import { Empty } from '../brand/Boot';

const NEXT: Record<string, { status: string; label: string } | undefined> = {
  ISSUED: { status: 'ACKNOWLEDGED', label: 'Acknowledge task' },
  ACKNOWLEDGED: { status: 'EN ROUTE', label: 'Moving — en route' },
  'EN ROUTE': { status: 'ON SCENE', label: 'On scene' },
  'ON SCENE': { status: 'COMPLETE', label: 'Task complete' },
};

const bearing = (a: { x: number; y: number }, b: { x: number; y: number }) => ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360;
const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const STEPS = ['ISSUED', 'ACKNOWLEDGED', 'EN ROUTE', 'ON SCENE', 'COMPLETE'];
const DRILLS = ['Confirm the grid on arrival', 'Observe, then send a SALUTE', 'Keep people back from the area', 'Update the control room'];

/** Arrival drills for the current task, kept on this device per task (Space UI checklist, without its auto-reset). */
function ArrivalDrills({ taskId }: { taskId: string }) {
  const key = `strata.field.drills.${taskId}`;
  const [items, setItems] = useState<ChecklistItem[]>(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved) return JSON.parse(saved) as ChecklistItem[];
    } catch {
      /* ignore */
    }
    return DRILLS.map((text, i) => ({ id: `d${i}`, text, done: false }));
  });
  const change = (next: ChecklistItem[]) => {
    setItems(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="field-drills">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="upper dim">Arrival drills</span>
        <span className="dim" style={{ fontSize: 11 }}>{items.filter((i) => i.done).length} of {items.length} · on this device</span>
      </div>
      <InteractiveChecklist className="w-full" items={items} onChange={change} resetWhenDone={false} maxItems={7} addLabel="Add a drill" />
    </div>
  );
}

/**
 * FIELD VIEW — for a QRT / patrol leader on a phone or tablet: my team, my task (orders, grid, distance and
 * bearing, status), a local picture, nearby alerts, a SALUTE contact report and an assistance request.
 */
export function Field() {
  const can = useSession((s) => s.can);
  const version = useOps((s) => s.version);
  const alerts = useData((s) => s.alerts);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 3000);
    return () => clearInterval(id);
  }, []);
  const teams = useAsync((s) => get<Team[]>('/api/ops/teams', s), [version, tick]);
  const tasks = useAsync((s) => get<Task[]>('/api/ops/tasks?active=1', s), [version, tick]);
  const [teamId, setTeamId] = useState<string>(() => localStorage.getItem('strata.field.team') ?? '');
  const team = teams.data?.find((t) => t.id === teamId) ?? null;
  const task = tasks.data?.find((t) => t.teamId === teamId && t.status !== 'COMPLETE' && t.status !== 'CANCELLED') ?? null;
  const [report, setReport] = useState<boolean | string>(false);
  // The slider takes a pixel width: fit it to its column so the end of the track is always reachable on a phone.
  const [slideW, setSlideW] = useState(340);
  const slideObs = useRef<ResizeObserver | null>(null);
  const slideBox = (el: HTMLDivElement | null) => {
    slideObs.current?.disconnect();
    if (!el) return;
    slideObs.current = new ResizeObserver(([e]) => setSlideW(Math.max(220, Math.min(380, Math.floor(e!.contentRect.width)))));
    slideObs.current.observe(el);
  };
  const { toast } = useToastStack();
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState('');
  const pick = (id: string) => {
    setTeamId(id);
    try {
      localStorage.setItem('strata.field.team', id);
    } catch {
      /* ignore */
    }
  };
  const near = useMemo(() => {
    const centre = team?.position;
    return alerts
      .filter((a) => a.status === 'open' || a.status === 'acknowledged')
      .filter((a) => a.priority === 'critical' || !centre || !a.position || Math.hypot(a.position.x - centre.x, a.position.y - centre.y) < 1500)
      .slice(0, 6);
  }, [alerts, team?.position]);
  const advance = async (status: string) => {
    if (!task) return;
    setErr(null);
    try {
      await post(`/api/ops/tasks/${task.id}/status`, { status, ...(status === 'COMPLETE' && outcome ? { outcome } : {}) });
      setOutcome('');
      tasks.reload();
      teams.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const ack = async (a: AlertRecord) => {
    try {
      await post(`/api/alerts/${a.id}/ack`, {});
      toast({ type: 'success', title: 'Alert acknowledged', description: a.title });
    } catch (e) {
      toast({ type: 'error', title: 'Not acknowledged', description: e instanceof Error ? e.message : String(e) });
    }
  };
  const dist = team?.position && task?.target ? Math.hypot(task.target.x - team.position.x, task.target.y - team.position.y) : null;
  const brg = team?.position && task?.target ? bearing(team.position, task.target) : null;

  return (
    <div className="field">
      <div className="field-top">
        <div className="field-team">
          <ArcSelect label="My team" placeholder="Select your team" value={teamId || undefined} onValueChange={pick} options={(teams.data ?? []).map((t) => ({ value: t.id, label: `${t.callsign} · ${t.kind}` }))} />
        </div>
        {team && <span className={`fstat s-${team.status.replace(' ', '-')}`}>{team.status}</span>}
      </div>
      {team && (
        <div className="field-pos mono">
          <span>{team.mgrs ?? 'no position fix'}</span>
          <span className="dim">{team.positionAgeS !== null ? `fix ${Math.round(team.positionAgeS)} s ago` : ''}</span>
        </div>
      )}
      {team && can('ops.log') && <ShareLocation teamId={team.id} onFix={() => teams.reload()} />}
      {!team && (
        <Empty art="tasks" title="Choose your team" description="The field view follows one team: its current task, position, nearby alerts and reports. Your choice is remembered on this device." />
      )}

      {team && (
        <>
          {task ? (
            <section className={`ftask p-${task.priority}`}>
              <div className="ftask-h">
                <span className="mono">TASK {String(task.number).padStart(3, '0')}</span>
                <span className={`chip ${task.priority === 'critical' ? 'red' : task.priority === 'high' ? 'amber' : ''}`}>{task.priority}</span>
                <span className="spacer" />
                <span className="mono dim">{task.status}</span>
              </div>
              <div className="ftask-orders">{task.orders}</div>
              <div className="ftask-loc">
                <div>
                  <span className="upper dim">Grid</span>
                  <b className="mono">{task.mgrs ?? task.locationText ?? '—'}</b>
                </div>
                <div>
                  <span className="upper dim">Distance</span>
                  <b className="mono">{dist === null ? '—' : dist >= 1000 ? `${(dist / 1000).toFixed(2)} km` : `${Math.round(dist)} m`}</b>
                </div>
                <div>
                  <span className="upper dim">Bearing</span>
                  <b className="mono">{brg === null ? '—' : `${String(Math.round(brg)).padStart(3, '0')}° ${CARD[Math.round(brg / 45) % 8]}`}</b>
                </div>
                <div>
                  <span className="upper dim">ETA</span>
                  <b className="mono">{task.etaS !== null ? `${Math.max(1, Math.round(task.etaS / 60))} min` : '—'}</b>
                </div>
              </div>
              {task.locationText && task.mgrs && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{task.locationText}</div>}
              {can('ops.dispatch') && NEXT[task.status] && (
                <>
                  {NEXT[task.status]!.status === 'COMPLETE' && (
                    <div style={{ marginTop: 12 }}>
                      <Textarea label="Outcome" rows={2} placeholder="What you found, actions taken" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
                    </div>
                  )}
                  <div className="field-slide" ref={slideBox}>
                    <SlideToConfirm key={`${task.status}-${slideW}`} width={slideW} label={`Slide: ${NEXT[task.status]!.label.toLowerCase()}`} confirmedLabel="Sent to control room" resetDelay={60_000} onConfirm={() => void advance(NEXT[task.status]!.status)} />
                  </div>
                </>
              )}
              <div className="field-steps">
                <Stepper label="Task progress" details="current" current={Math.max(0, STEPS.indexOf(task.status)) + 1} steps={STEPS.map((st) => ({ id: st, label: st.charAt(0) + st.slice(1).toLowerCase() }))} />
              </div>
              {(task.status === 'ON SCENE' || task.status === 'EN ROUTE') && <ArrivalDrills taskId={task.id} />}
            </section>
          ) : (
            <section className="ftask idle">
              <div className="ftask-h">
                <span>No active task</span>
              </div>
              <div className="muted">Standing by. New tasks from the control room appear here and sound the alarm.</div>
            </section>
          )}
          {err && <ErrorNote error={err} />}

          <div id="field-picture">
            <LocalPicture centre={team.position} target={task?.target ?? null} />
          </div>

          <section className="fsec" id="field-alerts">
            <h4>Alerts near you</h4>
            {near.length === 0 && <div className="muted">None.</div>}
            {near.length > 0 && (
              <SwipeActions label="Alerts near you" className="field-swipe">
                {near.map((a) => (
                  <SwipeActionsRow
                    key={a.id}
                    label={a.title}
                    leading={can('ops.log') ? [{ label: 'Report', icon: <Radio size={18} />, tone: 'accent', keepRow: true, onSelect: () => setReport(a.position ? grid(a.position) : true) }] : undefined}
                    trailing={can('alerts.acknowledge') && a.status === 'open' ? [{ label: 'Acknowledge', icon: <Bell size={18} />, tone: 'neutral', keepRow: true, onSelect: () => void ack(a) }] : undefined}
                  >
                    <NearAlert a={a} from={team.position} />
                  </SwipeActionsRow>
                ))}
              </SwipeActions>
            )}
            {near.length > 0 && <div className="dim" style={{ fontSize: 11.5, marginTop: 6 }}>Swipe right to report on an alert, left to acknowledge it.</div>}
          </section>

          <div className="factions" id="field-report">
            {can('ops.log') && (
              <Button variant="secondary" size="lg" className="field-big" onClick={() => setReport(true)}>
                Contact report (SALUTE)
              </Button>
            )}
            {can('ops.log') && <AssistButton teamId={team.id} />}
          </div>
        </>
      )}
      {report && <SaluteForm teamId={teamId || null} position={team?.position ?? null} location={typeof report === 'string' ? report : null} onClose={() => setReport(false)} />}
    </div>
  );
}

function NearAlert({ a, from }: { a: AlertRecord; from: Vec3 | null }) {
  const d = from && a.position ? Math.hypot(a.position.x - from.x, a.position.y - from.y) : null;
  const b = from && a.position ? bearing(from, a.position) : null;
  return (
    <div className={`fal p-${a.priority}`}>
      <span className={`prio ${a.priority}`} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">{a.title}</div>
        <div className="mono dim" style={{ fontSize: 11 }}>
          {new Date(a.t).toISOString().slice(11, 16)}Z{d !== null ? ` · ${Math.round(d)} m ${CARD[Math.round(b! / 45) % 8]}` : ''}
          {a.position ? ` · ${grid(a.position)}` : ''}
        </div>
      </div>
    </div>
  );
}

/** Press and hold for 1.5 s (Arc hold-to-confirm): an emergency control must not fire from a stray tap. */
function AssistButton({ teamId }: { teamId: string }) {
  const [sent, setSent] = useState<string | null>(null);
  const [done, setDone] = useState<boolean | undefined>(undefined);
  const send = () => {
    void post<AlertRecord>(`/api/ops/teams/${teamId}/assistance`, { note: '' })
      .then((a) => {
        setSent(`Sent ${new Date(a.t).toISOString().slice(11, 19)}Z — control room alerted`);
        useData.getState().onLive({ type: 'alert', alert: a });
        // Ready for another request after a few seconds.
        setTimeout(() => setDone(false), 6000);
        setTimeout(() => setDone(undefined), 6100);
      })
      .catch((e: unknown) => {
        setSent(e instanceof Error ? e.message : String(e));
        setDone(false);
        setTimeout(() => setDone(undefined), 100);
      });
  };
  return (
    <div className="col" style={{ gap: 4 }}>
      <HoldToConfirm className="field-assist" icon={<Siren size={18} />} label="Hold to request assistance" confirmedLabel="Assistance requested" tone="danger" duration={1500} onConfirm={send} confirmed={done} />
      {sent && <span className="mono" style={{ fontSize: 11.5, color: 'var(--st-critical-text)' }}>{sent}</span>}
    </div>
  );
}

function SaluteForm({ teamId, position, location, onClose }: { teamId: string | null; position: Vec3 | null; location: string | null; onClose: () => void }) {
  const [f, setF] = useState({ size: '', activity: '', location: location ?? (position ? grid(position) : ''), unit: '', time: `${new Date().toISOString().slice(11, 16).replace(':', '')}Z`, equipment: '' });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [sending, setSending] = useState(false);
  const fields: [keyof typeof f, string, string][] = [
    ['size', 'S — Size', 'how many: 2 persons, 1 vehicle'],
    ['activity', 'A — Activity', 'what they are doing'],
    ['location', 'L — Location', 'grid reference or description'],
    ['unit', 'U — Unit / uniform', 'dress, markings, identification'],
    ['time', 'T — Time', 'time observed'],
    ['equipment', 'E — Equipment', 'weapons, vehicles, tools, drones'],
  ];
  return (
    <Modal title="Contact report (SALUTE)" onClose={onClose}>
      {ok ? (
        <div className="col">
          <div className="note ok">Report sent to the control room and recorded in the duty log.</div>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <div className="col salute" style={{ gap: 12 }}>
          {fields.map(([k, label, ph]) => (
            <Input key={k} label={label} value={f[k]} placeholder={ph} className={k === 'location' || k === 'time' ? 'mono' : undefined} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          ))}
          {err && <ErrorNote error={err} />}
          <Button
            size="lg"
            className="field-big"
            loading={sending}
            disabled={!f.activity && !f.size}
            onClick={() => {
              setSending(true);
              void post('/api/ops/contact-report', { teamId, ...f, ...(position ? { position: { x: position.x, y: position.y } } : {}) })
                .then(() => setOk(true))
                .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
                .finally(() => setSending(false));
            }}
          >
            Send report
          </Button>
        </div>
      )}
    </Modal>
  );
}

/** Local north-up picture around the team: contacts within ~600 m, the task location and a bearing line. */
function LocalPicture({ centre, target }: { centre: Vec3 | null; target: { x: number; y: number } | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const vas = useOps((s) => s.vitalAssets);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    let raf = 0;
    let list: RenderTrack[] = [];
    let last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 500) return;
      last = now;
      list = trackStore.liveAt(useTime.getState().currentLiveEdge());
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) return;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const c = centre ?? { x: 0, y: 0 };
      const R = 600;
      const k = Math.min(w, h) / 2 / R;
      const P = (x: number, y: number) => [w / 2 + (x - c.x) * k, h / 2 - (y - c.y) * k] as const;
      ctx.fillStyle = C.bg0;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = alpha(C.grid, 0.14);
      for (const r of [150, 300, 450, 600]) {
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, r * k, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = C.text2;
      ctx.font = '10px "JetBrains Mono Variable", monospace';
      ctx.fillText('300 m', w / 2 + 3, h / 2 - 300 * k + 11);
      ctx.fillText('N', w / 2 - 3, 12);
      for (const v of vas) {
        const [x, y] = P(v.centre.x, v.centre.y);
        ctx.strokeStyle = alpha(C.zone, 0.5);
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(x, y, v.radiusM * k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (target) {
        const [tx, ty] = P(target.x, target.y);
        ctx.strokeStyle = C.text0;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(w / 2, h / 2);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(tx, ty, 9 + Math.sin(now / 300) * 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tx - 5, ty);
        ctx.lineTo(tx + 5, ty);
        ctx.moveTo(tx, ty - 5);
        ctx.lineTo(tx, ty + 5);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      for (const tr of list) {
        const [x, y] = P(tr.position.x, tr.position.y);
        if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
        const img = symbolTexture(symbolFor(tr, false)).image as HTMLCanvasElement;
        ctx.globalAlpha = tr.inferred ? 0.5 : 1;
        ctx.drawImage(img, x - 11, y - 11, 22, 22);
        ctx.globalAlpha = 1;
      }
      // Own position.
      ctx.fillStyle = C.friend;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = alpha(C.friend, 0.5);
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 9 + ((now / 40) % 14), 0, Math.PI * 2);
      ctx.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [centre, target, vas]);
  return (
    <section className="fsec">
      <h4>Local picture · 600 m</h4>
      <canvas ref={ref} className="flocal" aria-label="Local picture around your team" />
    </section>
  );
}

/**
 * Share this phone's GNSS position as the team's position. Fixes go to the server's field-device feed (as a
 * gps.position observation), at most every 3 s, or sooner after moving 15 m. Works only while this page is open.
 */
function ShareLocation({ teamId, onFix }: { teamId: string; onFix: () => void }) {
  const key = `strata.field.share.${teamId}`;
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(key) === 'on';
    } catch {
      return false;
    }
  });
  const [status, setStatus] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const last = useRef<{ t: number; lat: number; lon: number } | null>(null);
  const fixed = useRef(onFix);
  fixed.current = onFix;
  const toggle = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(key, v ? 'on' : 'off');
    } catch {
      /* session only */
    }
  };
  useEffect(() => {
    if (!on) {
      setStatus(null);
      return;
    }
    if (!navigator.geolocation) {
      setBad(true);
      setStatus('This browser cannot report its location.');
      return;
    }
    if (!window.isSecureContext) {
      setBad(true);
      setStatus('Location needs a secure connection (HTTPS).');
      return;
    }
    setStatus('Waiting for a GNSS fix…');
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const { latitude: lat, longitude: lon, accuracy, altitude, speed, heading } = p.coords;
        const prev = last.current;
        const moved = prev ? Math.hypot((lat - prev.lat) * 111_320, (lon - prev.lon) * 111_320 * Math.cos((lat * Math.PI) / 180)) : Infinity;
        if (prev && Date.now() - prev.t < 3000 && moved < 15) return;
        last.current = { t: Date.now(), lat, lon };
        void post(`/api/ops/teams/${teamId}/position`, {
          lat,
          lon,
          accuracyM: Math.max(1, Math.min(1000, accuracy)),
          ...(altitude != null ? { alt: altitude } : {}),
          ...(speed != null && speed >= 0 ? { speedMps: Math.min(200, speed) } : {}),
          ...(heading != null && !Number.isNaN(heading) ? { headingDeg: heading % 360 } : {}),
          at: Math.round(p.timestamp),
        })
          .then(() => {
            setBad(false);
            setStatus(`Sharing · ±${Math.round(accuracy)} m · sent ${new Date().toISOString().slice(11, 19)}Z`);
            fixed.current();
          })
          .catch((e: unknown) => {
            setBad(true);
            setStatus(e instanceof Error ? e.message : String(e));
          });
      },
      (e) => {
        setBad(true);
        setStatus(e.code === e.PERMISSION_DENIED ? 'Location permission was refused. Allow it for this site in the browser settings.' : `No fix: ${e.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [on, teamId]);
  return (
    <section className="fshare">
      <Switch checked={on} onCheckedChange={toggle} label="Share my position" />
      {status && <span className={`mono fshare-st ${bad ? 'bad' : ''}`}>{status}</span>}
    </section>
  );
}
