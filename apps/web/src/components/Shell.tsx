import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Popover as P } from 'radix-ui';
import { Keyboard, Moon, Sun, Bell, BellOff, Search, Settings2 } from 'lucide-react';
import { toMgrs, type AlertRecord } from '@strata/domain';
import { useSession } from '../state/session';
import { useWorld } from '../state/world';
import { useData } from '../state/data';
import { useVisionLive } from '../api/vision';
import { post } from '../api/client';
import { useOps } from '../state/ops';
import { useUi } from '../state/ui';
import { NAV, pageTitle } from '../lib/nav';
import { Icon } from './Icons';
import { Dialog, Tip } from './ui';
import { AnnouncementBar, Breadcrumb, PopoverContent, ToastStack, ToastStackProvider, UserMenu } from './kit';
import { CommandBar } from './patterns/CommandBar';
import { StatusIsland } from './patterns/StatusIsland';
import { MacKeyboard } from './vendor/componentry/mac-keyboard';
import { Mark } from '../brand/Mark';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

/**
 * Console frame. The rail (56 px, icons with names on hover) runs the full height beside a 48 px top bar that
 * carries where you are (site › page), the command bar, and the status island. Content gets everything else.
 */
export function Shell({ children }: { children: ReactNode }) {
  const cls = useOps((s) => s.classification);
  const loc = useLocation();
  const [cmd, setCmd] = useState(false);
  const [keys, setKeys] = useState(false);
  const banner = `${cls.level}${cls.caveat ? ` // ${cls.caveat}` : ''}`;
  const area = loc.pathname.split('/')[1] ?? '';
  useGlobalKeys(() => setCmd(true), () => setKeys(true));
  return (
    <ToastStackProvider>
      <div className={`shell cls-${cls.level.replace(' ', '-')}`}>
        <div className="cls-banner top" role="note" aria-label={`Classification ${banner}`}>
          {banner}
        </div>
        <Rail onShortcuts={() => setKeys(true)} />
        <TopBar onCommand={() => setCmd(true)} onShortcuts={() => setKeys(true)} />
        <main className="main">
          <DemoNotice />
          <div className="route" key={area}>
            {children}
          </div>
        </main>
        <div className="cls-banner bottom">{banner}</div>
        <AlertToasts />
        <ToastStack position="bottom-right" label="Console notifications" />
        <ConnectionWatch />
        <CommandBar open={cmd} onOpenChange={setCmd} onShortcuts={() => setKeys(true)} />
        <ShortcutsDialog open={keys} onOpenChange={setKeys} />
      </div>
    </ToastStackProvider>
  );
}

/**
 * Demonstration mode is said plainly on every screen until the operator dismisses it for this browser
 * (Arc announcement bar); the "Demo" chip in the top bar stays regardless.
 */
function DemoNotice() {
  const runMode = useWorld((s) => s.runMode);
  if (runMode !== 'demo') return null;
  return (
    <div className="demo-notice">
      <AnnouncementBar
        id="strata-demo-notice-v1"
        label="Demonstration mode"
        tone="neutral"
        autoPlay={false}
        messages={[
          {
            id: 'demo',
            message: (
              <>
                Demonstration site: sensors, tracks, people and faces are simulated, and nothing here is a real observation. Operational use starts the server with <code>STRATA_MODE=operational</code>.
              </>
            ),
          },
        ]}
      />
    </div>
  );
}

/** ⌘K / Ctrl K for the command bar, ? for shortcuts, and "G then letter" to go to an area. */
function useGlobalKeys(openCommand: () => void, openShortcuts: () => void) {
  const nav = useNavigate();
  const pendingG = useRef(0);
  useEffect(() => {
    const goto: Record<string, string> = {};
    for (const i of NAV.flatMap((g) => g.items)) if (i.keys?.startsWith('G ')) goto[i.keys.slice(2).toLowerCase()] = i.to;
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openCommand();
        return;
      }
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
      if (e.key === '?') {
        e.preventDefault();
        openShortcuts();
      } else if (e.key.toLowerCase() === 'g') pendingG.current = Date.now();
      else if (Date.now() - pendingG.current < 1200 && goto[e.key.toLowerCase()]) {
        pendingG.current = 0;
        nav(goto[e.key.toLowerCase()]!);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [nav, openCommand, openShortcuts]);
}

function Rail({ onShortcuts }: { onShortcuts: () => void }) {
  const can = useSession((s) => s.can);
  const simulated = useWorld((s) => s.simulated);
  const pending = useVisionLive((s) => s.pendingReview);
  const alerts = useData((s) => s.alerts);
  const critical = useMemo(() => alerts.filter((a) => a.status === 'open' && a.priority === 'critical').length, [alerts]);
  return (
    <nav className="rail" aria-label="Application areas">
      <Link to="/operations" className="rail-logo" aria-label="Strata home">
        <Mark size={28} />
      </Link>
      <div className="rail-items">
        {NAV.map((g, gi) => {
          const items = g.items.filter((n) => (!n.perm || can(n.perm)) && (!n.simulated || simulated));
          if (!items.length) return null;
          return (
            <div key={g.group} className="rail-group" role="group" aria-label={g.group}>
              {gi > 0 && <span className="rail-sep" aria-hidden="true" />}
              {items.map((n) => {
                const I = Icon[n.icon] as () => ReactNode;
                const badge = n.to === '/identity' && pending > 0 ? pending : n.to === '/operations' && critical > 0 ? critical : 0;
                return (
                  <Tip
                    key={n.to}
                    side="right"
                    content={
                      <span className="tip-nav">
                        {n.label}
                        {n.keys && <span className="tip-keys">{n.keys.split(' ').map((k) => <kbd key={k}>{k}</kbd>)}</span>}
                      </span>
                    }
                  >
                    <NavLink to={n.to} className={({ isActive }) => `rail-item ${isActive ? 'active' : ''}`} aria-label={n.label}>
                      <I />
                      {badge > 0 && <span className={`rail-badge ${n.to === '/operations' ? 'red' : ''}`}>{badge > 99 ? '99+' : badge}</span>}
                    </NavLink>
                  </Tip>
                );
              })}
            </div>
          );
        })}
      </div>
      <Tip content={<span className="tip-nav">Keyboard shortcuts<span className="tip-keys"><kbd>?</kbd></span></span>} side="right">
        <button className="rail-item rail-foot" onClick={onShortcuts} aria-label="Keyboard shortcuts">
          <Keyboard size={18} strokeWidth={1.75} />
        </button>
      </Tip>
    </nav>
  );
}

function TopBar({ onCommand, onShortcuts }: { onCommand: () => void; onShortcuts: () => void }) {
  const loc = useLocation();
  const nav = useNavigate();
  const user = useSession((s) => s.user);
  const can = useSession((s) => s.can);
  const logout = useSession((s) => s.logout);
  const sound = useOps((s) => s.sound);
  const setSound = useOps((s) => s.setSound);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const facility = useWorld((s) => s.facility);
  const runMode = useWorld((s) => s.runMode);
  const [siteOpen, setSiteOpen] = useState(false);

  const siteName = facility?.name.split(' — ')[0] ?? 'Site';
  const title = pageTitle(loc.pathname);
  const area = NAV.flatMap((g) => g.items).find((i) => loc.pathname.startsWith(i.to));
  const rest = area ? loc.pathname.slice(area.to.length).split('/').filter(Boolean) : [];
  const crumbs = [
    { label: siteName, onClick: () => setSiteOpen((o) => !o) },
    rest.length && area ? { label: title, href: area.to } : { label: title },
    ...(rest.length ? [{ label: rest.map((x) => decodeURIComponent(x)).join(' · ') }] : []),
  ];
  const role = user?.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : '';
  useEffect(() => {
    document.title = `${title} · ${siteName} · Strata`;
  }, [title, siteName]);

  return (
    <header className="topbar">
      <div className="tb-left">
        <P.Root open={siteOpen} onOpenChange={setSiteOpen}>
          <P.Anchor asChild>
            <div className="tb-crumbs">
              <Breadcrumb items={crumbs} ariaLabel="Location" />
            </div>
          </P.Anchor>
          <PopoverContent className="site-pop" align="start">
            <SiteCard onClose={() => setSiteOpen(false)} canEdit={can('admin.config')} />
          </PopoverContent>
        </P.Root>
        {runMode === 'demo' && <span className="tb-demo">Demo</span>}
      </div>
      <button className="cmd-trigger" onClick={onCommand} aria-label="Open command bar">
        <Search size={15} strokeWidth={2} />
        <span className="cmd-trigger-text">Search or run a command</span>
        <span className="cmd-trigger-keys">
          <kbd className="kbd">{MOD}</kbd>
          <kbd className="kbd">K</kbd>
        </span>
      </button>
      <div className="tb-right">
        <StatusIsland />
        {user && (
          <UserMenu
            className="user-btn"
            user={{ name: user.displayName, email: `${user.username} · ${role}` }}
            showTheme={false}
            items={[
              { label: theme === 'night' ? 'Standard display' : 'Night display (red light)', icon: theme === 'night' ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />, onSelect: () => setTheme(theme === 'night' ? 'dark' : 'night') },
              { label: sound ? 'Mute alarm sound' : 'Enable alarm sound', icon: sound ? <BellOff size={16} strokeWidth={1.75} /> : <Bell size={16} strokeWidth={1.75} />, onSelect: () => setSound(!sound) },
              { label: 'Keyboard shortcuts', icon: <Keyboard size={16} strokeWidth={1.75} />, keys: ['?'], onSelect: onShortcuts },
              ...(can('admin.users') ? [{ label: 'Users & settings', icon: <Settings2 size={16} strokeWidth={1.75} />, onSelect: () => nav('/admin') }] : []),
            ]}
            onSignOut={() => logout()}
          />
        )}
      </div>
    </header>
  );
}

function SiteCard({ onClose, canEdit }: { onClose: () => void; canEdit: boolean }) {
  const facility = useWorld((s) => s.facility);
  const runMode = useWorld((s) => s.runMode);
  const basemap = useWorld((s) => s.basemap);
  const ortho = useWorld((s) => s.orthophoto);
  const nav = useNavigate();
  if (!facility) return null;
  const [name, sub] = facility.name.split(' — ');
  const o = facility.origin;
  let grid = '';
  try {
    grid = toMgrs(o.lat, o.lon, 5, true);
  } catch {
    /* outside MGRS coverage */
  }
  return (
    <div className="site-card">
      <div className="site-card-h">
        <b>{name}</b>
        {sub && <span className="muted">{sub}</span>}
      </div>
      <dl className="kv">
        <dt>Mode</dt>
        <dd>{runMode === 'demo' ? 'Demonstration (simulated data)' : 'Operational'}</dd>
        <dt>Site origin</dt>
        <dd className="mono">{grid || '—'}</dd>
        <dt>Latitude, longitude</dt>
        <dd className="mono">
          {o.lat.toFixed(5)}, {o.lon.toFixed(5)}
        </dd>
        <dt>Area</dt>
        <dd>
          {((facility.halfExtentM * 2) / 1000).toFixed(1)} × {((facility.halfExtentM * 2) / 1000).toFixed(1)} km
        </dd>
        <dt>Ground imagery</dt>
        <dd>{ortho ? 'Orthophoto' : basemap ? 'Map tiles' : 'None'}</dd>
        <dt>Zones / buildings</dt>
        <dd>
          {facility.zones.length} / {facility.buildings.length}
        </dd>
      </dl>
      {canEdit && (
        <div className="site-card-f">
          <button
            className="btn small"
            onClick={() => {
              onClose();
              nav('/site');
            }}
          >
            Edit site
          </button>
        </div>
      )}
    </div>
  );
}

const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Anywhere',
    items: [
      [`${MOD} K`, 'Command bar: search, grid reference, go to, actions'],
      ['?', 'Keyboard shortcuts'],
      ['G O', 'Operational picture'],
      ['G C', 'Command'],
      ['G W', 'Camera wall'],
      ['G I', 'Incidents'],
      ['G F', 'Field view'],
      ['G S', 'Sensors'],
    ],
  },
  {
    group: 'Operational picture',
    items: [
      ['Space', 'Play or pause'],
      ['← →', 'Step 1 s (Shift: 10 s)'],
      ['L', 'Return to live'],
      ['Esc', 'Clear selection'],
      ['/', 'Ask the copilot'],
    ],
  },
];

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  if (!open) return null;
  return (
    <Dialog onClose={() => onOpenChange(false)} title="Keyboard shortcuts" description="Press any key to see it on the keyboard." wide>
      <div className="keys-grid">
        {SHORTCUTS.map((g) => (
          <section key={g.group}>
            <h4>{g.group}</h4>
            {g.items.map(([k, d]) => (
              <div key={k} className="keys-row">
                <span className="keys-k">
                  {k.split(' ').map((x) => (
                    <kbd key={x} className="kbd">
                      {x}
                    </kbd>
                  ))}
                </span>
                <span className="muted">{d}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="keys-board">
        <MacKeyboard soundSrc="" />
      </div>
    </Dialog>
  );
}

const TOAST_MS = { high: 9000, critical: 0 } as const;
const ruleLabel = (r: string) => r.charAt(0) + r.slice(1).toLowerCase().replace(/_/g, ' ');

/** New critical/high alerts as toasts: critical ones stay until dismissed or acknowledged. */
function AlertToasts() {
  const alerts = useData((s) => s.alerts);
  const can = useSession((s) => s.can);
  const nav = useNavigate();
  const seen = useRef<Set<string> | null>(null);
  const [list, setList] = useState<{ a: AlertRecord; out: boolean }[]>([]);
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(alerts.map((a) => a.id));
      return;
    }
    const fresh = alerts.filter((a) => !seen.current!.has(a.id) && a.status === 'open' && (a.priority === 'critical' || a.priority === 'high') && Date.now() - a.t < 120_000);
    for (const a of alerts) seen.current.add(a.id);
    if (fresh.length) setList((l) => [...fresh.map((a) => ({ a, out: false })), ...l].slice(0, 4));
    // Acknowledged elsewhere: drop it here too.
    setList((l) => l.filter((x) => alerts.find((a) => a.id === x.a.id)?.status === 'open'));
  }, [alerts]);
  const dismiss = (id: string) => {
    setList((l) => l.map((x) => (x.a.id === id ? { ...x, out: true } : x)));
    setTimeout(() => setList((l) => l.filter((x) => x.a.id !== id)), 260);
  };
  useEffect(() => {
    const timers = list.filter((x) => x.a.priority === 'high' && !x.out).map((x) => setTimeout(() => dismiss(x.a.id), TOAST_MS.high));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.map((x) => x.a.id).join()]);
  const show = (a: AlertRecord) => {
    nav('/operations');
    const w = useWorld.getState();
    w.select({ kind: 'alert', id: a.id });
    if (a.position) w.flyTo(a.position, 260);
    dismiss(a.id);
  };
  const ack = async (a: AlertRecord) => {
    const r = await post<AlertRecord>(`/api/alerts/${a.id}/ack`).catch(() => null);
    if (r) useData.getState().onLive({ type: 'alert', alert: r });
    dismiss(a.id);
  };
  if (!list.length) return null;
  return (
    <div className="toasts" aria-live="assertive">
      {list.map(({ a, out }) => (
        <div key={a.id} className={`toast ${a.priority} ${out ? 'out' : ''}`} role="alert">
          <div className="t-head">
            {a.priority === 'critical' ? <span className="live-dot red" /> : <Icon.Alert />}
            <span className="t-sev">{a.priority}</span>
            <span className="ellipsis">{ruleLabel(a.rule)}</span>
            <span className="spacer" />
            <span className="mono">{new Date(a.t).toISOString().slice(11, 19)}Z</span>
            <button className="btn ghost small icon" aria-label="Dismiss" onClick={() => dismiss(a.id)} style={{ width: 20, height: 20 }}>
              <Icon.Close />
            </button>
          </div>
          <div className="t-title">{a.title}</div>
          <div className="t-actions">
            <button className="btn small" onClick={() => show(a)}>
              Show on map
            </button>
            {can('alerts.acknowledge') && (
              <button className={`btn small ${a.priority === 'critical' ? 'critical' : 'primary'}`} onClick={() => void ack(a)}>
                Acknowledge
              </button>
            )}
          </div>
          {a.priority === 'high' && <div className="t-timer" style={{ animationDuration: `${TOAST_MS.high}ms` }} />}
        </div>
      ))}
    </div>
  );
}

/** A console must never silently show stale data: say so when the live connection drops. */
function ConnectionWatch() {
  const ws = useData((s) => s.wsStatus);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (ws === 'open') {
      setLost(false);
      return;
    }
    const id = setTimeout(() => setLost(true), 3000);
    return () => clearTimeout(id);
  }, [ws]);
  if (!lost) return null;
  return (
    <div className="conn-lost" role="alert">
      <span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,0.35)', width: 12, height: 12 }} />
      Live connection lost — reconnecting. The picture is not updating.
    </div>
  );
}

