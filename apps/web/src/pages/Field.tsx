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
import { Icon } from '../components/Icons';
import type { Task, Team } from '../components/ops/OpsWidgets';
import { alpha, P as C } from '../lib/palette';
import '../styles/field.css';

const NEXT: Record<string, { status: string; label: string } | undefined> = {
  ISSUED: { status: 'ACKNOWLEDGED', label: 'Acknowledge task' },
  ACKNOWLEDGED: { status: 'EN ROUTE', label: 'Moving — en route' },
  'EN ROUTE': { status: 'ON SCENE', label: 'On scene' },
  'ON SCENE': { status: 'COMPLETE', label: 'Task complete' },
};

const bearing = (a: { x: number; y: number }, b: { x: number; y: number }) => ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360;
const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

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
  const [report, setReport] = useState(false);
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
  const dist = team?.position && task?.target ? Math.hypot(task.target.x - team.position.x, task.target.y - team.position.y) : null;
  const brg = team?.position && task?.target ? bearing(team.position, task.target) : null;

  return (
    <div className="field">
      <div className="field-top">
        <select className="input field-team" value={teamId} onChange={(e) => pick(e.target.value)} aria-label="My team">
          <option value="">Select your team…</option>
          {teams.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.callsign} · {t.kind}
            </option>
          ))}
        </select>
        {team && <span className={`fstat s-${team.status.replace(' ', '-')}`}>{team.status}</span>}
      </div>
      {team && (
        <div className="field-pos mono">
          <span>{team.mgrs ?? 'no position fix'}</span>
          <span className="dim">{team.positionAgeS !== null ? `fix ${Math.round(team.positionAgeS)} s ago` : ''}</span>
        </div>
      )}
      {!team && (
        <div className="empty-state">
          <Icon.Field />
          <h3>Choose your team</h3>
          <p>The field view follows one team: its current task, position, nearby alerts and reports. Your choice is remembered on this device.</p>
        </div>
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
                  {NEXT[task.status]!.status === 'COMPLETE' && <textarea className="input" rows={2} placeholder="Outcome (what you found, actions taken)" value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ width: '100%', marginTop: 10 }} />}
                  <button className="btn primary field-big" onClick={() => void advance(NEXT[task.status]!.status)}>
                    {NEXT[task.status]!.label}
                  </button>
                </>
              )}
              <div className="fsteps">
                {['ISSUED', 'ACKNOWLEDGED', 'EN ROUTE', 'ON SCENE', 'COMPLETE'].map((st, i, arr) => (
                  <span key={st} className={arr.indexOf(task.status) >= i ? 'done' : ''}>
                    {st}
                  </span>
                ))}
              </div>
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

          <LocalPicture centre={team.position} target={task?.target ?? null} />

          <section className="fsec">
            <h4>Alerts near you</h4>
            {near.length === 0 && <div className="muted">None.</div>}
            {near.map((a) => (
              <NearAlert key={a.id} a={a} from={team.position} />
            ))}
          </section>

          <div className="factions">
            {can('ops.log') && (
              <button className="btn field-big" onClick={() => setReport(true)}>
                Contact report (SALUTE)
              </button>
            )}
            {can('ops.log') && <AssistButton teamId={team.id} />}
          </div>
        </>
      )}
      {report && <SaluteForm teamId={teamId || null} position={team?.position ?? null} onClose={() => setReport(false)} />}
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

/** Press and hold for 1.5 s: an emergency control must not fire from a stray tap. */
function AssistButton({ teamId }: { teamId: string }) {
  const [hold, setHold] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = () => {
    setHold(true);
    timer.current = setTimeout(() => {
      setHold(false);
      void post<AlertRecord>(`/api/ops/teams/${teamId}/assistance`, { note: '' })
        .then((a) => (setSent(`Sent ${new Date(a.t).toISOString().slice(11, 19)}Z — control room alerted`), useData.getState().onLive({ type: 'alert', alert: a })))
        .catch((e: unknown) => setSent(e instanceof Error ? e.message : String(e)));
    }, 1500);
  };
  const cancel = () => {
    setHold(false);
    if (timer.current) clearTimeout(timer.current);
  };
  return (
    <div className="col" style={{ gap: 4 }}>
      <button className={`btn field-big assist ${hold ? 'holding' : ''}`} onPointerDown={start} onPointerUp={cancel} onPointerLeave={cancel} onContextMenu={(e) => e.preventDefault()}>
        <span className="assist-fill" />
        <span style={{ position: 'relative' }}>{hold ? 'Keep holding…' : 'Hold to request assistance'}</span>
      </button>
      {sent && <span className="mono" style={{ fontSize: 11.5, color: 'var(--red)' }}>{sent}</span>}
    </div>
  );
}

function SaluteForm({ teamId, position, onClose }: { teamId: string | null; position: Vec3 | null; onClose: () => void }) {
  const [f, setF] = useState({ size: '', activity: '', location: position ? grid(position) : '', unit: '', time: `${new Date().toISOString().slice(11, 16).replace(':', '')}Z`, equipment: '' });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
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
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        <div className="col" style={{ gap: 10 }}>
          {fields.map(([k, label, ph]) => (
            <label key={k} className="col" style={{ gap: 3 }}>
              <span className="upper muted">{label}</span>
              <input className="input" style={{ height: 36 }} value={f[k]} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            </label>
          ))}
          {err && <ErrorNote error={err} />}
          <button
            className="btn primary field-big"
            disabled={!f.activity && !f.size}
            onClick={() =>
              void post('/api/ops/contact-report', { teamId, ...f, ...(position ? { position: { x: position.x, y: position.y } } : {}) })
                .then(() => setOk(true))
                .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
            }
          >
            Send report
          </button>
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
