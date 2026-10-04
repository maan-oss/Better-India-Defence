/**
 * Tasks as a board (Space UI Kanban on dnd-kit): one column per task state. Dragging a card forward records the
 * status change, which is audited; only the transitions a task can make are accepted, and closing a task asks for
 * the outcome. Keyboard: focus a card's handle, Space to lift, arrows to move, Space to drop.
 */
import { useEffect, useMemo, useState } from 'react';
import { GripVertical, X } from 'lucide-react';
import { post } from '../../api/client';
import { useOps } from '../../state/ops';
import { Kanban, KanbanBoard, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanItemHandle, KanbanOverlay } from '../vendor/spaceui/components/spaceui/kanban';
import { Modal, Prio } from '../common';
import type { Task } from './OpsWidgets';

const COLS = ['ISSUED', 'ACKNOWLEDGED', 'EN ROUTE', 'ON SCENE', 'CLOSED'] as const;
type Col = (typeof COLS)[number];
const LABEL: Record<Col, string> = { ISSUED: 'Issued', ACKNOWLEDGED: 'Acknowledged', 'EN ROUTE': 'En route', 'ON SCENE': 'On scene', CLOSED: 'Closed' };
const NEXT: Record<string, string[]> = {
  ISSUED: ['ACKNOWLEDGED', 'EN ROUTE', 'CANCELLED'],
  ACKNOWLEDGED: ['EN ROUTE', 'ON SCENE', 'CANCELLED'],
  'EN ROUTE': ['ON SCENE', 'CANCELLED'],
  'ON SCENE': ['COMPLETE'],
};
const colOf = (t: Task): Col => (t.status === 'COMPLETE' || t.status === 'CANCELLED' ? 'CLOSED' : (t.status as Col));
const dtg = (t: number) => new Date(t).toISOString().slice(11, 16) + 'Z';

function group(tasks: Task[]): Record<Col, Task[]> {
  const g = Object.fromEntries(COLS.map((c) => [c, [] as Task[]])) as Record<Col, Task[]>;
  for (const t of tasks) g[colOf(t)].push(t);
  g.CLOSED = g.CLOSED.slice(0, 8);
  return g;
}

export function TaskBoard({ tasks, canDispatch }: { tasks: Task[]; canDispatch: boolean }) {
  const server = useMemo(() => group(tasks), [tasks]);
  const [cols, setCols] = useState<Record<string, Task[]>>(server);
  const [closing, setClosing] = useState<Task | null>(null);
  const [outcome, setOutcome] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setCols(server), [server]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const bump = () => useOps.setState((s) => ({ version: s.version + 1 }));
  const send = (t: Task, status: string, out?: string) =>
    post(`/api/ops/tasks/${t.id}/status`, { status, ...(out ? { outcome: out } : {}) })
      .then(bump)
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : String(e));
        setCols(server);
      });

  const commit = (_v: Record<string, Task[]>, meta: { kind: string; activeContainer: string; overContainer: string; event: { active: { id: string | number } } }) => {
    if (meta.kind !== 'item' || meta.activeContainer === meta.overContainer) return;
    const t = byId.get(String(meta.event.active.id));
    const to = meta.overContainer as Col;
    if (!t) return setCols(server);
    const allowed = NEXT[t.status] ?? [];
    if (to === 'CLOSED') {
      if (!allowed.includes('COMPLETE')) {
        setErr(`#${t.number} must be on scene before it can be completed (or cancel it).`);
        return setCols(server);
      }
      setOutcome('');
      setClosing(t);
      return;
    }
    if (!allowed.includes(to)) {
      setErr(`#${t.number} cannot go from ${t.status.toLowerCase()} to ${to.toLowerCase()}.`);
      return setCols(server);
    }
    setErr(null);
    void send(t, to);
  };

  const card = (t: Task, overlay = false) => (
    <div className={`tb-card ${t.status === 'CANCELLED' ? 'cancelled' : ''} ${overlay ? 'overlay' : ''}`}>
      <div className="tb-card-h">
        {canDispatch && colOf(t) !== 'CLOSED' && !overlay ? (
          <KanbanItemHandle className="tb-grip" aria-label={`Move task ${t.number}`}>
            <GripVertical size={14} />
          </KanbanItemHandle>
        ) : (
          <span className="tb-grip off" />
        )}
        <Prio p={t.priority} />
        <b className="mono">#{t.number}</b>
        <span className="mono tb-call">{t.callsign}</span>
        <span className="spacer" />
        <span className="mono dim">{dtg(t.createdAt)}</span>
      </div>
      <p className="tb-orders">{t.orders}</p>
      <div className="tb-meta mono">
        {t.mgrs ? t.mgrs : (t.locationText ?? '')}
        {t.etaS !== null && colOf(t) !== 'CLOSED' ? ` · ETA ~${Math.ceil(t.etaS / 60)} min` : ''}
        {t.status === 'CANCELLED' ? ' · cancelled' : t.outcome ? ` · ${t.outcome}` : ''}
      </div>
      {canDispatch && NEXT[t.status]?.includes('CANCELLED') && !overlay && (
        <button className="tb-cancel" onClick={() => void send(t, 'CANCELLED')} aria-label={`Cancel task ${t.number}`} title="Cancel task">
          <X size={12} />
        </button>
      )}
    </div>
  );

  return (
    <>
      {err && (
        <div className="tb-err" role="status">
          {err}
          <button className="btn ghost small icon" onClick={() => setErr(null)} aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}
      <Kanban value={cols} onValueChange={setCols} getItemValue={(t: Task) => t.id} onValueCommit={commit} restoreOnCancel>
        <KanbanBoard className="tb-board">
          {COLS.map((c) => (
            <KanbanColumn key={c} value={c} disabled className={`tb-col c-${c.replace(' ', '-')}`}>
              <header className="tb-col-h">
                <span>{LABEL[c]}</span>
                <span className="tb-n">{cols[c]?.length ?? 0}</span>
              </header>
              <KanbanColumnContent value={c} className="tb-col-body">
                {(cols[c] ?? []).map((t) => (
                  <KanbanItem key={t.id} value={t.id} disabled={!canDispatch || c === 'CLOSED'}>
                    {card(t)}
                  </KanbanItem>
                ))}
                {(cols[c] ?? []).length === 0 && <div className="tb-empty">—</div>}
              </KanbanColumnContent>
            </KanbanColumn>
          ))}
        </KanbanBoard>
        <KanbanOverlay>{({ value, variant }) => (variant === 'item' && byId.get(String(value)) ? card(byId.get(String(value))!, true) : null)}</KanbanOverlay>
      </Kanban>
      {closing && (
        <Modal title={`Complete task #${closing.number} (${closing.callsign})`} onClose={() => (setClosing(null), setCols(server))}>
          <textarea className="input" rows={3} style={{ width: '100%' }} autoFocus placeholder="Outcome as reported by the team" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <div className="spacer" />
            <button className="btn primary" disabled={outcome.trim().length < 3} onClick={() => (void send(closing, 'COMPLETE', outcome), setClosing(null))}>
              Record outcome
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
