/**
 * Status island: the console's live state in one pill — time (live or replay), readiness, open alerts, sensors and
 * the live link. Selecting it opens a panel that morphs out of the pill (pattern after Bencho's "Dynamic island",
 * bencho.dev; original implementation on Motion shared layout) with the detail behind each figure.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowUpRight, Radio, RotateCcw } from 'lucide-react';
import { useTime } from '../../state/time';
import { useOps } from '../../state/ops';
import { useData } from '../../state/data';
import { useWorld } from '../../state/world';
import { SplitFlapDisplay } from '../vendor/componentry/split-flap-display';
import { NotificationList, type NotificationItem } from '../vendor/spaceui/components/spaceui/notification-list';
import { StatusBadge } from '../vendor/spaceui/components/spaceui/status-badge';
import './patterns.css';

const zulu = (t: number) => new Date(t).toISOString().slice(11, 19);
const zDate = (t: number) => new Date(t).toISOString().slice(0, 10);
const localFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });
const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);
const ruleLabel = (r: string) => r.charAt(0) + r.slice(1).toLowerCase().replace(/_/g, ' ');

function useTick(ms: number) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function StatusIsland() {
  useTick(250);
  const reduced = useReducedMotion() ?? false;
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { mode, t, rate, direction, playing } = useTime.getState();
  const edge = useTime.getState().currentLiveEdge();
  // Live: wall-clock Zulu (the data's own age is shown in the panel). Replay: the playhead.
  const now = mode === 'live' ? Date.now() : t;
  const readiness = useOps((s) => s.readiness);
  const alerts = useData((s) => s.alerts);
  const sensors = useData((s) => s.sensors);
  const ws = useData((s) => s.wsStatus);
  const facility = useWorld((s) => s.facility);

  const open_ = useMemo(() => alerts.filter((a) => a.status === 'open'), [alerts]);
  const crit = open_.filter((a) => a.priority === 'critical').length;
  const high = open_.filter((a) => a.priority === 'high').length;
  const configured = facility?.sensors.length ?? 0;
  // A configured sensor counts as down until it has actually reported.
  const ids = facility?.sensors.map((s) => s.id) ?? [];
  const reporting = ids.filter((id) => sensors[id]?.status === 'ok' || sensors[id]?.status === 'degraded').length;
  const down = configured - reporting;
  const degraded = ids.filter((id) => sensors[id]?.status === 'degraded').length;
  const level = readiness?.level ?? 'NORMAL';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const go = (to: string) => {
    setOpen(false);
    nav(to);
  };
  const showAlert = (id: string) => {
    const a = alerts.find((x) => x.id === id);
    go('/operations');
    if (!a) return;
    useWorld.getState().select({ kind: 'alert', id });
    if (a.position) useWorld.getState().flyTo(a.position, 260);
  };

  const topAlerts: NotificationItem[] = open_
    .filter((a) => a.priority === 'critical' || a.priority === 'high')
    .sort((a, b) => (a.priority === b.priority ? b.t - a.t : a.priority === 'critical' ? -1 : 1))
    .slice(0, 4)
    .map((a) => ({ id: a.id, title: a.title, subtitle: ruleLabel(a.rule), time: `${zulu(a.t).slice(0, 5)}Z`, tone: a.priority as NotificationItem['tone'] }));

  const spring = reduced ? { duration: 0 } : { type: 'spring' as const, visualDuration: 0.32, bounce: 0.14 };
  const timeLabel = mode === 'live' ? 'Live' : playing ? `${direction < 0 ? 'Rewind' : 'Replay'} ×${rate}` : 'Paused';

  const pill = (
    <>
      <span className={`isl-seg isl-time ${mode}`}>
        {mode === 'live' ? <span className="live-dot" /> : <RotateCcw size={13} strokeWidth={2} />}
        <span className="isl-mode">{timeLabel}</span>
        <span className="mono">{zulu(now)}Z</span>
      </span>
      <span className={`isl-seg isl-ready r-${level.replace(' ', '-')}`} title={`Readiness ${level}`}>
        <i />
        {level}
      </span>
      <span className="isl-seg isl-alerts" title={`${crit} critical, ${high} high-priority and ${open_.length - crit - high} other alerts open`}>
        {crit + high === 0 ? (
          <span className="dim">{open_.length ? `${open_.length} open` : 'No alerts'}</span>
        ) : (
          <>
            {crit > 0 && (
              <span className="isl-n crit">
                <span className="prio critical" />
                {crit}
              </span>
            )}
            {high > 0 && (
              <span className="isl-n">
                <span className="prio high" />
                {high}
              </span>
            )}
          </>
        )}
      </span>
      <span className="isl-seg isl-sensors" title={configured ? `${configured - down} of ${configured} sensors reporting` : 'No sensors configured'}>
        <span className={`status-dot ${down ? 'silent' : degraded ? 'degraded' : configured ? 'ok' : 'offline'}`} style={configured ? undefined : { background: 'var(--st-off)', boxShadow: 'none' }} />
        {configured ? (down ? `${down} down` : `${configured}`) : '0'}
        <span className="dim isl-unit">{!down && configured === 1 ? 'sensor' : 'sensors'}</span>
      </span>
      {ws !== 'open' && (
        <span className="isl-seg isl-link" title="Live connection">
          <span className="status-dot degraded" />
          {ws === 'connecting' ? 'Connecting' : 'Offline'}
        </span>
      )}
    </>
  );

  return (
    <div className="island-wrap" ref={root}>
      {/* Keeps the pill's place in the bar while the panel is open. */}
      <div className="island island-ghost" aria-hidden="true">
        {pill}
      </div>
      <AnimatePresence initial={false}>
        {!open ? (
          <motion.button key="pill" layoutId="island" className={`island ${crit ? 'has-crit' : ''}`} onClick={() => setOpen(true)} aria-expanded={false} aria-label="Console status" transition={spring} style={{ borderRadius: 999 }}>
            <motion.span className="island-row" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
              {pill}
            </motion.span>
          </motion.button>
        ) : (
          <motion.div key="panel" layoutId="island" className="island-panel" role="dialog" aria-label="Console status" transition={spring} style={{ borderRadius: 18 }}>
            <motion.div className="isp-body" initial={{ opacity: 0, y: -4, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={{ delay: reduced ? 0 : 0.08, duration: 0.2 }}>
              <section className="isp-clock">
                <SplitFlapDisplay text={zulu(now)} columns={8} size="sm" showIndicators={false} staggerDelay={14} flipSpeed={26} className="isp-flap" />
                <div className="isp-clock-meta">
                  <span className="isp-k">{mode === 'live' ? 'Zulu time' : 'Viewing'}</span>
                  <span className="mono">{zDate(now)} · Z</span>
                  <span className="muted">Local {localFmt.format(new Date(now))}</span>
                  {mode === 'live' ? (
                    <span className="dim" title="Age of the newest processed observation">
                      Newest data {ago(Math.max(0, Date.now() - edge))} old
                    </span>
                  ) : (
                    <button className="btn small" onClick={() => (useTime.getState().goLive(), setOpen(false))}>
                      <Radio size={13} /> Return to live
                    </button>
                  )}
                </div>
              </section>

              <section className="isp-sec">
                <header>
                  <span className="isp-k">Readiness</span>
                  <button className="isp-link" onClick={() => go('/command')}>
                    Command <ArrowUpRight size={12} />
                  </button>
                </header>
                <div className="isp-ready">
                  <span className={`readiness r-${level.replace(' ', '-')}`}>{level}</span>
                  <span className="muted ellipsis">{readiness?.reason || 'Normal posture'}</span>
                </div>
                {readiness?.by && (
                  <div className="dim isp-small">
                    Set by {readiness.by} {readiness.t ? `· ${ago(Date.now() - readiness.t)} ago` : ''}
                  </div>
                )}
              </section>

              <section className="isp-sec">
                <header>
                  <span className="isp-k">Open alerts</span>
                  <span className="dim isp-small">{open_.length} open</span>
                </header>
                {topAlerts.length ? (
                  <NotificationList items={topAlerts} label="Open alerts" onItem={showAlert} onViewAll={() => go('/operations')} className="isp-alerts" />
                ) : (
                  <div className="isp-empty">No critical or high-priority alerts.</div>
                )}
              </section>

              <section className="isp-sec isp-row">
                <button className="isp-tile" onClick={() => go('/sensors')}>
                  <StatusBadge status={!configured ? 'offline' : down ? 'error' : degraded ? 'warning' : 'online'} primaryText="Sensors" size="sm" variant="outline" animated={down > 0} mode="stack">
                    {configured ? `${configured - down} of ${configured} reporting` : 'None configured'}
                  </StatusBadge>
                </button>
                <button className="isp-tile" onClick={() => go('/system')}>
                  <StatusBadge status={ws === 'open' ? 'online' : ws === 'connecting' ? 'warning' : 'error'} primaryText="Live link" size="sm" variant="outline" animated={ws !== 'open'} mode="stack">
                    {ws === 'open' ? 'Connected' : ws === 'connecting' ? 'Connecting…' : 'Disconnected'}
                  </StatusBadge>
                </button>
              </section>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
