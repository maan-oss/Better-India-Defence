/**
 * First steps on an empty operational picture. Each step is checked from the live state of the site (not ticked by
 * hand), so the card reflects what is actually connected and leaves once the site is producing a picture.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronRight, X } from 'lucide-react';
import { useWorld } from '../../state/world';
import { useData } from '../../state/data';
import { useSession } from '../../state/session';
import { Progress } from '../kit';

const KEY = 'strata.getstarted.hidden';

export function GetStarted() {
  const facility = useWorld((s) => s.facility);
  const runMode = useWorld((s) => s.runMode);
  const sensors = useData((s) => s.sensors);
  const can = useSession((s) => s.can);
  const nav = useNavigate();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(KEY) === facility?.id;
    } catch {
      return false;
    }
  });
  if (!facility || runMode !== 'operational') return null;

  const cams = facility.sensors.filter((s) => s.kind === 'camera');
  const feeds = facility.sensors.filter((s) => s.kind === 'gps' || s.kind === 'external' || s.kind === 'drone');
  const reporting = (ids: string[]) => ids.some((id) => sensors[id]?.status === 'ok' || sensors[id]?.status === 'degraded');
  const admin = can('admin.config');
  const steps = [
    { id: 'site', label: 'Place the site', detail: facility.name.split(' — ')[0]!, done: true, to: '/site' },
    { id: 'perimeter', label: 'Draw the perimeter and zones', detail: 'Restricted areas raise alerts on entry', done: facility.fence.length > 2 || facility.zones.length > 0, to: admin ? '/site' : null },
    { id: 'camera', label: 'Add a camera', detail: 'An IP camera, or this device’s camera', done: cams.length > 0, to: '/cameras?add=1' },
    { id: 'phone', label: 'Share positions from a phone', detail: 'Open Field view on a responder’s phone', done: reporting(feeds.filter((f) => f.kind === 'gps').map((f) => f.id)), to: '/field' },
    { id: 'feeds', label: 'Connect data feeds', detail: 'NMEA, MAVLink or Cursor-on-Target', done: reporting(feeds.filter((f) => f.kind !== 'gps').map((f) => f.id)), to: admin ? '/site' : null },
  ];
  const done = steps.filter((s) => s.done).length;
  const show = !hidden && (cams.length === 0 || done < 3);

  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(KEY, facility.id);
    } catch {
      /* session only */
    }
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.section className="get-started glass-2" aria-label="Get started" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={{ type: 'spring', visualDuration: 0.35, bounce: 0.1 }}>
          <header>
            <div>
              <h3>Bring the site online</h3>
              <p>The picture fills in as sources connect. Nothing here is simulated.</p>
            </div>
            <button className="btn ghost small icon" onClick={hide} aria-label="Hide for this site">
              <X size={14} />
            </button>
          </header>
          <Progress value={done} max={steps.length} label={`${done} of ${steps.length} done`} showValue className="gs-progress" />
          <ol>
            {steps.map((s, i) => (
              <li key={s.id}>
                <button className={`gs-step ${s.done ? 'done' : ''}`} disabled={!s.to} onClick={() => s.to && nav(s.to)}>
                  <span className="gs-mark">{s.done ? <Check size={13} strokeWidth={2.5} /> : i + 1}</span>
                  <span className="gs-text">
                    <b>{s.label}</b>
                    <span>{s.detail}</span>
                  </span>
                  {s.to && !s.done && <ChevronRight size={15} className="gs-go" />}
                </button>
              </li>
            ))}
          </ol>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
