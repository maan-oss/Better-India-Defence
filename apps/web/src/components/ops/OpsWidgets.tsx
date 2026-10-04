import { useState } from 'react';
import type { AlertRecord } from '@strata/domain';
import { get, post } from '../../api/client';
import { useSession } from '../../state/session';
import { useOps } from '../../state/ops';
import { ErrorNote, Modal, useAsync } from '../common';

export interface Team {
  id: string;
  callsign: string;
  kind: string;
  strength: number;
  leader: string | null;
  channel: string | null;
  entityId: string | null;
  mode: 'foot' | 'vehicle';
  status: string;
  position: { x: number; y: number; z: number } | null;
  positionAgeS: number | null;
  mgrs: string | null;
  taskId: string | null;
}

export interface Task {
  id: string;
  number: number;
  teamId: string;
  callsign: string;
  alertId: string | null;
  incidentId: string | null;
  target: { x: number; y: number } | null;
  mgrs: string | null;
  locationText: string | null;
  orders: string;
  priority: string;
  status: string;
  etaS: number | null;
  createdBy: string;
  createdAt: number;
  history: { t: number; status: string; by: string; note?: string }[];
  outcome: string | null;
  closedAt: number | null;
}

/** SOP checklist for an alert: each step is ticked by name and time (audited, noted on the alert). */
export function Checklist({ alertId }: { alertId: string }) {
  const can = useSession((s) => s.can);
  const c = useAsync((s) => get<{ rule: string; items: { index: number; text: string; doneBy: string | null; doneAt: number | null }[] }>(`/api/ops/checklists/${alertId}`, s), [alertId]);
  if (!c.data) return null;
  const done = c.data.items.filter((i) => i.doneBy).length;
  return (
    <div className="section">
      <h4>
        Standing orders · {done}/{c.data.items.length}
      </h4>
      <ol className="sop">
        {c.data.items.map((i) => (
          <li key={i.index} className={i.doneBy ? 'done' : ''}>
            <label className="check">
              <input type="checkbox" checked={Boolean(i.doneBy)} disabled={Boolean(i.doneBy) || !can('alerts.acknowledge')} onChange={() => void post(`/api/ops/checklists/${alertId}/${i.index}`, {}).then(c.reload)} />
              <span>{i.text}</span>
            </label>
            {i.doneBy && (
              <span className="mono dim" style={{ fontSize: 10.5 }}>
                {i.doneBy} {new Date(i.doneAt!).toISOString().slice(11, 19)}Z
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

const DEFAULT_ORDERS: Record<string, string> = {
  UNIDENTIFIED_AERIAL: 'Move toward the RF bearing origin, locate the controller, observe and report. Do not engage.',
  RESTRICTED_ZONE_ENTRY: 'Intercept and challenge the intruder; detain and report.',
  WATCHLIST_CANDIDATE: 'Locate and observe the person; await identity confirmation before approach.',
  UNKNOWN_PERSON_RESTRICTED: 'Challenge, identify and escort out of the restricted zone.',
  FENCE_ALARM: 'Inspect the fence segment and report damage or intrusion.',
  THREAT_IMMINENT: 'Move to the threatened asset, warn personnel and report.',
};

export function DispatchDialog({ alert, onClose }: { alert: AlertRecord | null; onClose: () => void }) {
  const teams = useAsync((s) => get<Team[]>('/api/ops/teams', s), []);
  const [teamId, setTeamId] = useState('');
  const [orders, setOrders] = useState(alert ? (DEFAULT_ORDERS[alert.rule] ?? 'Proceed to the location, assess and report.') : '');
  const [grid, setGrid] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const target = alert?.position ?? null;
  const dist = (t: Team) => (t.position && target ? Math.hypot(t.position.x - target.x, t.position.y - target.y) : null);
  const sorted = [...(teams.data ?? [])].sort((a, b) => (a.taskId ? 1 : 0) - (b.taskId ? 1 : 0) || (dist(a) ?? 1e9) - (dist(b) ?? 1e9));
  const go = async () => {
    setErr(null);
    try {
      await post('/api/ops/tasks', { teamId, alertId: alert?.id ?? null, orders, priority: alert?.priority ?? 'high', ...(grid ? { mgrs: grid } : {}) });
      useOps.setState((s) => ({ version: s.version + 1 }));
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal title={alert ? `Dispatch — ${alert.title}` : 'Dispatch team'} onClose={onClose}>
      <div className="col" style={{ gap: 10 }}>
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>Team</th>
              <th>Status</th>
              <th>Position</th>
              <th>Distance / ETA</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => {
              const d = dist(t);
              const eta = d !== null ? Math.ceil((d * 1.35) / (t.mode === 'vehicle' ? 8 : 2) / 60) : null;
              return (
                <tr key={t.id} className={`click ${teamId === t.id ? 'sel' : ''}`} onClick={() => !t.taskId && setTeamId(t.id)} style={{ opacity: t.taskId ? 0.45 : 1 }}>
                  <td>
                    <input type="radio" checked={teamId === t.id} disabled={Boolean(t.taskId)} onChange={() => setTeamId(t.id)} aria-label={t.callsign} />
                  </td>
                  <td>
                    <b className="mono">{t.callsign}</b> <span className="dim">{t.kind} · {t.strength}</span>
                  </td>
                  <td>{t.taskId ? 'tasked' : t.status}</td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {t.mgrs ?? 'no GPS'}
                    {t.positionAgeS !== null && t.positionAgeS > 60 ? <span className="err-inline"> ({t.positionAgeS}s old)</span> : null}
                  </td>
                  <td className="mono">{d !== null ? `${Math.round(d)} m · ~${eta} min` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!target && (
          <div className="formgrid">
            <label>Grid (MGRS)</label>
            <input className="input" value={grid} placeholder="e.g. 31N AA 66021 00000" onChange={(e) => setGrid(e.target.value)} />
          </div>
        )}
        <textarea className="input" rows={3} value={orders} onChange={(e) => setOrders(e.target.value)} placeholder="Orders (recorded in the duty log)" />
        {err && <ErrorNote error={err} />}
        <div className="row">
          <span className="muted">ETA uses straight-line distance × 1.35 at {`2 m/s on foot, 8 m/s by vehicle`}; the team confirms by radio.</span>
          <div className="spacer" />
          <button className="btn primary" disabled={!teamId || orders.trim().length < 3} onClick={() => void go()}>
            Dispatch
          </button>
        </div>
      </div>
    </Modal>
  );
}
