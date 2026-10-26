/**
 * Inbox: what needs someone to act, in one list. Open alerts, sensors that are down or degraded, and identity
 * reviews waiting. A toast can be missed, so anything still open stays here until its condition clears.
 * A popover on wide screens, a bottom sheet on phones.
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { Popover as P } from 'radix-ui';
import { Bell, Check } from 'lucide-react';
import type { AlertRecord, SensorStatusRecord } from '@strata/domain/client';
import { post } from '../../api/client';
import { useVisionLive } from '../../api/vision';
import { useData } from '../../state/data';
import { useSession } from '../../state/session';
import { useWorld } from '../../state/world';
import { PopoverContent } from '../arc/popover/popover';
import { Drawer, DrawerContent } from '../arc/drawer/drawer';
import { Tally } from '../Tally';

const RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
const SENSOR_TEXT: Record<string, string> = { silent: 'Silent', offline: 'Offline', fault: 'Fault', degraded: 'Degraded' };
const zulu = (t: number) => `${new Date(t).toISOString().slice(11, 16)}Z`;
const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);
const ruleLabel = (r: string) => r.charAt(0) + r.slice(1).toLowerCase().replace(/_/g, ' ');

const narrowQuery = '(max-width: 760px)';
const subscribeNarrow = (change: () => void) => {
  const q = window.matchMedia(narrowQuery);
  q.addEventListener('change', change);
  return () => q.removeEventListener('change', change);
};
const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => window.matchMedia(narrowQuery).matches, () => false);

export function Inbox() {
  const [open, setOpen] = useState(false);
  const narrow = useNarrow();
  const alerts = useData((s) => s.alerts);
  const sensors = useData((s) => s.sensors);
  const facility = useWorld((s) => s.facility);
  const pending = useVisionLive((s) => s.pendingReview);

  const openAlerts = useMemo(() => alerts.filter((a) => a.status === 'open').sort((a, b) => RANK[a.priority] - RANK[b.priority] || b.t - a.t), [alerts]);
  const troubled = useMemo(() => Object.values(sensors).filter((s) => s.status !== 'ok'), [sensors]);
  const names = useMemo(() => Object.fromEntries((facility?.sensors ?? []).map((d) => [d.id, d.name])), [facility]);
  const count = openAlerts.length + troubled.length;
  const crit = openAlerts.some((a) => a.priority === 'critical');

  const label = count ? `Inbox, ${count} need action` : 'Inbox, nothing needs action';
  const cls = `tb-bell${crit ? ' crit' : ''}`;
  const icon = <Bell size={16} strokeWidth={1.75} />;
  // The count is in the label; the rolling digits are decoration, so they stay out of the name.
  const badge = count > 0 && <span aria-hidden="true"><Tally className="tb-bell-n" value={count} cap={99} /></span>;
  const body = <InboxBody alerts={openAlerts} troubled={troubled} names={names} pending={pending} count={count} onDone={() => setOpen(false)} />;

  if (narrow) {
    return (
      <>
        <button type="button" className={cls} aria-label={label} aria-expanded={open} onClick={() => setOpen(true)}>
          {icon}
          {badge}
        </button>
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent side="bottom" title="Inbox" description={count ? `${count} need action` : 'Nothing needs action'}>
            {body}
          </DrawerContent>
        </Drawer>
      </>
    );
  }
  return (
    <P.Root open={open} onOpenChange={setOpen}>
      <P.Trigger className={cls} aria-label={label}>
        {icon}
        {badge}
      </P.Trigger>
      <PopoverContent align="end" className="inbox-pop">
        {body}
      </PopoverContent>
    </P.Root>
  );
}

function InboxBody({ alerts, troubled, names, pending, count, onDone }: { alerts: AlertRecord[]; troubled: SensorStatusRecord[]; names: Record<string, string>; pending: number; count: number; onDone: () => void }) {
  const nav = useNavigate();
  const can = useSession((s) => s.can);

  const show = (a: AlertRecord) => {
    onDone();
    nav('/operations');
    const w = useWorld.getState();
    w.select({ kind: 'alert', id: a.id });
    if (a.position) w.flyTo(a.position, 260);
  };
  const ack = async (a: AlertRecord) => {
    const r = await post<AlertRecord>(`/api/alerts/${a.id}/ack`).catch(() => null);
    if (r) useData.getState().onLive({ type: 'alert', alert: r });
  };
  const go = (to: string) => {
    onDone();
    nav(to);
  };

  if (count === 0) {
    return (
      <div className="inbox">
        <div className="inbox-empty">Nothing needs action. Checked {zulu(Date.now())}.</div>
      </div>
    );
  }
  return (
    <div className="inbox">
      {alerts.length > 0 && (
        <section className="inbox-sec" aria-label="Open alerts">
          <h2 className="sub-h">Alerts</h2>
          <ul>
            {alerts.slice(0, 12).map((a) => (
              <li key={a.id} className="inbox-row">
                <button type="button" className="inbox-main" onClick={() => show(a)}>
                  <span className={`prio ${a.priority}`} />
                  <span className="inbox-text">
                    <span className="inbox-title">{a.title}</span>
                    <span className="inbox-meta">
                      {ruleLabel(a.rule)} · {zulu(a.t)}
                    </span>
                  </span>
                </button>
                {can('alerts.acknowledge') && (
                  <button type="button" className="btn ghost small icon" aria-label={`Acknowledge: ${a.title}`} onClick={() => void ack(a)}>
                    <Check size={14} strokeWidth={2} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {alerts.length > 12 && (
            <button type="button" className="inbox-more" onClick={() => go('/operations')}>
              Show all {alerts.length} on the operational picture
            </button>
          )}
        </section>
      )}
      {troubled.length > 0 && (
        <section className="inbox-sec" aria-label="Sensors">
          <h2 className="sub-h">Sensors</h2>
          <ul>
            {troubled.map((s) => (
              <li key={s.sensorId} className="inbox-row">
                <button type="button" className="inbox-main" onClick={() => go(`/sensors/${encodeURIComponent(s.sensorId)}`)}>
                  <span className={`status-dot ${s.status === 'degraded' ? 'degraded' : 'silent'}`} />
                  <span className="inbox-text">
                    <span className="inbox-title">{names[s.sensorId] ?? s.sensorId}</span>
                    <span className="inbox-meta">
                      {SENSOR_TEXT[s.status]}
                      {s.lastSeen ? ` · last seen ${ago(Date.now() - s.lastSeen)} ago` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {pending > 0 && (
        <section className="inbox-sec" aria-label="Identity">
          <h2 className="sub-h">Identity</h2>
          <ul>
            <li className="inbox-row">
              <button type="button" className="inbox-main" onClick={() => go('/identity')}>
                <span className="inbox-text">
                  <span className="inbox-title">
                    {pending} {pending === 1 ? 'review' : 'reviews'} waiting
                  </span>
                  <span className="inbox-meta">Recognition candidates to confirm or reject</span>
                </span>
              </button>
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}
