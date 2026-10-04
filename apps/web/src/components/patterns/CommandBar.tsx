/**
 * Command bar (⌘K / Ctrl K): one place to search the site, jump to a grid reference, go to any area and run
 * console actions. Interaction pattern after Bencho's "Command bar" block (bencho.dev) — a highlight that glides
 * between results and a dialog that springs from the trigger. Original implementation on Radix Dialog + Motion.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog } from 'radix-ui';
import { AnimatePresence, motion } from 'motion/react';
import { EnuFrame, fromMgrs, terrainHeight } from '@strata/domain';
import { get } from '../../api/client';
import { useWorld } from '../../state/world';
import { useTime } from '../../state/time';
import { useUi } from '../../state/ui';
import { useOps } from '../../state/ops';
import { useSession } from '../../state/session';
import { NAV } from '../../lib/nav';
import { Icon } from '../Icons';
import './patterns.css';

interface Result {
  id: string;
  group: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  keys?: string;
  run: () => void;
}
type SearchHit = { kind: string; id: string; label: string; detail: string };

const isGrid = (q: string) => /^\s*\d{1,2}\s*[C-HJ-NP-X]\s*[A-HJ-NP-Z]{2}\s*\d{2,10}\s*\d*\s*$/i.test(q);

export function CommandBar({ open, onOpenChange, onShortcuts }: { open: boolean; onOpenChange: (o: boolean) => void; onShortcuts: () => void }) {
  const nav = useNavigate();
  const can = useSession((s) => s.can);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQ('');
      setHits([]);
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || isGrid(term)) {
      setHits([]);
      return;
    }
    const ctl = new AbortController();
    const id = setTimeout(() => {
      get<SearchHit[]>(`/api/search?q=${encodeURIComponent(term)}`, ctl.signal)
        .then(setHits)
        .catch(() => setHits([]));
    }, 120);
    return () => {
      clearTimeout(id);
      ctl.abort();
    };
  }, [q]);

  const close = () => onOpenChange(false);
  const results = useMemo<Result[]>(() => {
    const term = q.trim().toLowerCase();
    const out: Result[] = [];
    const facility = useWorld.getState().facility;
    if (isGrid(q) && facility) {
      out.push({
        id: 'grid',
        group: 'Grid reference',
        label: `Fly to ${q.trim().toUpperCase()}`,
        detail: 'MGRS',
        icon: <Icon.Target />,
        run: () => {
          try {
            const g = fromMgrs(q);
            const p = new EnuFrame(facility.origin).toEnu({ lat: g.lat, lon: g.lon, alt: 0 });
            const z = terrainHeight(p.x, p.y);
            nav('/operations');
            useWorld.getState().flyTo({ x: p.x, y: p.y, z }, Math.max(200, g.precisionM * 2));
            useWorld.getState().select({ kind: 'point', position: { x: p.x, y: p.y, z } });
          } catch {
            /* not a valid reference */
          }
        },
      });
    }
    for (const h of hits)
      out.push({
        id: `${h.kind}:${h.id}`,
        group: 'On this site',
        label: h.label,
        detail: `${h.kind} · ${h.detail}`,
        icon: <Icon.Search />,
        run: () => openHit(h, nav),
      });
    const pages: Result[] = NAV.flatMap((g) => g.items)
      .filter((i) => !i.perm || can(i.perm))
      .map((i) => {
        const I = Icon[i.icon] as () => ReactNode;
        return { id: `nav:${i.to}`, group: 'Go to', label: i.label, icon: <I />, keys: i.keys, run: () => nav(i.to) };
      });
    const theme = useUi.getState().theme;
    const sound = useOps.getState().sound;
    const actions: Result[] = [
      { id: 'live', group: 'Actions', label: 'Return to live', icon: <Icon.Play />, keys: 'L', run: () => (useTime.getState().goLive(), nav('/operations')) },
      { id: 'night', group: 'Actions', label: theme === 'night' ? 'Standard display' : 'Night display (red light)', icon: theme === 'night' ? <Icon.Sun /> : <Icon.Moon />, run: () => useUi.getState().setTheme(theme === 'night' ? 'dark' : 'night') },
      { id: 'sound', group: 'Actions', label: sound ? 'Mute alarm sound' : 'Enable alarm sound', icon: sound ? <Icon.BellOff /> : <Icon.Bell />, run: () => useOps.getState().setSound(!sound) },
      { id: 'keys', group: 'Actions', label: 'Keyboard shortcuts', icon: <Icon.Command />, keys: '?', run: onShortcuts },
    ];
    const match = (r: Result) => !term || r.label.toLowerCase().includes(term) || (r.detail ?? '').toLowerCase().includes(term);
    return [...out, ...pages.filter(match), ...actions.filter(match)];
  }, [q, hits, can, nav, onShortcuts]);

  useEffect(() => setActive(0), [q, hits.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const runAt = (i: number) => {
    const r = results[i];
    if (!r) return;
    close();
    // Let the dialog close (and return focus) before navigating.
    setTimeout(r.run, 0);
  };

  let lastGroup = '';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div className="cmd-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }} />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <motion.div className="cmd" initial={{ opacity: 0, y: -12, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.12 } }} transition={{ type: 'spring', visualDuration: 0.28, bounce: 0.12 }}>
                <Dialog.Title className="sr-only">Command bar</Dialog.Title>
                <div className="cmd-input">
                  <Icon.Search />
                  <input
                    autoFocus
                    placeholder="Search the site, enter a grid reference, or type a command"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setActive((a) => Math.min(results.length - 1, a + 1));
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setActive((a) => Math.max(0, a - 1));
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        runAt(active);
                      }
                    }}
                    aria-label="Command"
                    aria-controls="cmd-list"
                    aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
                  />
                  <span className="kbd">Esc</span>
                </div>
                <div className="cmd-list scroll" id="cmd-list" role="listbox" ref={listRef}>
                  {results.length === 0 && <div className="cmd-empty">Nothing matches “{q}”.</div>}
                  {results.map((r, i) => {
                    const head = r.group !== lastGroup ? r.group : null;
                    lastGroup = r.group;
                    return (
                      <div key={r.id}>
                        {head && <div className="cmd-group">{head}</div>}
                        <div
                          id={`cmd-${r.id}`}
                          role="option"
                          aria-selected={i === active}
                          data-index={i}
                          className={`cmd-item ${i === active ? 'on' : ''}`}
                          onMouseMove={() => i !== active && setActive(i)}
                          onClick={() => runAt(i)}
                        >
                          {i === active && <motion.span layoutId="cmd-hl" className="cmd-hl" transition={{ type: 'spring', visualDuration: 0.18, bounce: 0.1 }} />}
                          <span className="cmd-icon">{r.icon}</span>
                          <span className="cmd-label">{r.label}</span>
                          {r.detail && <span className="cmd-detail">{r.detail}</span>}
                          {r.keys && <span className="cmd-keys">{r.keys.split(' ').map((k) => <kbd key={k} className="kbd">{k}</kbd>)}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="cmd-foot">
                  <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> move</span>
                  <span><kbd className="kbd">↵</kbd> open</span>
                  <span className="spacer" />
                  <span>Grid references: e.g. 43R GM 30415 77880</span>
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

/** Open a search hit: incidents have a page; everything else is shown on the operational picture. */
export function openHit(r: SearchHit, nav: (to: string) => void) {
  const w = useWorld.getState();
  const facility = w.facility;
  if (r.kind === 'incident') return nav(`/incidents/${r.id}`);
  nav('/operations');
  if (r.kind === 'coordinates' && facility) {
    const [a, b] = r.id.split(',').map(Number) as [number, number];
    const isGeo = r.label.includes('.') && Math.abs(a) <= 90 && Math.abs(b) <= 180 && Math.abs(a) < 1 && Math.abs(b) < 1;
    const p = isGeo ? new EnuFrame(facility.origin).toEnu({ lat: a, lon: b, alt: 0 }) : { x: a, y: b, z: 0 };
    w.flyTo({ x: p.x, y: p.y, z: terrainHeight(p.x, p.y) }, 300);
    w.select({ kind: 'point', position: { x: p.x, y: p.y, z: terrainHeight(p.x, p.y) } });
  } else if (r.kind === 'building' && facility) {
    const b = facility.buildings.find((x) => x.id === r.id);
    if (b) w.flyTo({ x: b.center.x, y: b.center.y, z: 0 }, Math.max(180, b.width * 3));
    w.select({ kind: 'building', id: r.id });
  } else if (r.kind === 'sensor' && facility) {
    const s = facility.sensors.find((x) => x.id === r.id);
    if (s && 'position' in s) w.flyTo(s.position, 220);
    w.select({ kind: 'sensor', id: r.id });
  } else if (r.kind === 'zone' && facility) {
    const z = facility.zones.find((x) => x.id === r.id);
    if (z) w.flyTo({ x: z.polygon.reduce((s, p) => s + p.x, 0) / z.polygon.length, y: z.polygon.reduce((s, p) => s + p.y, 0) / z.polygon.length, z: 0 }, 700);
  } else if (r.kind === 'track') w.select({ kind: 'track', id: r.id });
}
