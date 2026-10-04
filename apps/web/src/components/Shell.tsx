import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../state/session';
import { MODES, useWorld, type GlobalMode } from '../state/world';
import { useTime } from '../state/time';
import { useData } from '../state/data';
import { useVisionLive } from '../api/vision';
import { get } from '../api/client';
import { Icon } from './Icons';
import { dateTime } from '../lib/format';
import { EnuFrame, fromMgrs, terrainHeight } from '@strata/domain';
import { useOps } from '../state/ops';
import { useUi } from '../state/ui';
import { post } from '../api/client';
import type { AlertRecord } from '@strata/domain';

type NavItem = { to: string; label: string; icon: keyof typeof Icon; perm?: string };
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Operate',
    items: [
      { to: '/operations', label: 'Operational picture', icon: 'Ops' },
      { to: '/command', label: 'Command', icon: 'Command' },
      { to: '/cameras', label: 'Camera wall', icon: 'Camera', perm: 'media.view' },
      { to: '/incidents', label: 'Incidents', icon: 'Incidents' },
      { to: '/field', label: 'Field view', icon: 'Field' },
    ],
  },
  {
    group: 'Intelligence',
    items: [
      { to: '/identity', label: 'Identity', icon: 'Identity', perm: 'identity.view' },
      { to: '/forensics', label: 'Media forensics', icon: 'Forensics' },
      { to: '/evidence', label: 'Evidence', icon: 'Evidence' },
      { to: '/reconstructions', label: 'Reconstructions', icon: 'Recon' },
    ],
  },
  {
    group: 'Systems',
    items: [
      { to: '/sensors', label: 'Sensors', icon: 'Sensors' },
      { to: '/system', label: 'System health', icon: 'Health', perm: 'system.view' },
      { to: '/simulation', label: 'Simulation lab', icon: 'Sim', perm: 'simulation.control' },
      { to: '/audit', label: 'Audit', icon: 'Audit', perm: 'audit.view' },
    ],
  },
  {
    group: 'Administer',
    items: [
      { to: '/admin', label: 'Users & settings', icon: 'Admin', perm: 'admin.users' },
      { to: '/site', label: 'Site setup', icon: 'Target', perm: 'admin.config' },
    ],
  },
];

export function Shell({ children }: { children: ReactNode }) {
  const cls = useOps((s) => s.classification);
  const railOpen = useUi((s) => s.railOpen);
  const loc = useLocation();
  const banner = `${cls.level}${cls.caveat ? ` // ${cls.caveat}` : ''}`;
  const area = loc.pathname.split('/')[1] ?? '';
  return (
    <div className={`shell cls-${cls.level} ${railOpen ? 'rail-open' : ''}`}>
      <div className="cls-banner top" role="note" aria-label={`Classification ${banner}`}>
        {banner}
      </div>
      <TopBar />
      <Rail />
      <main className="main">
        <div className="route" key={area}>
          {children}
        </div>
      </main>
      <div className="cls-banner bottom">{banner}</div>
      <Toasts />
      <ConnectionWatch />
    </div>
  );
}

function Rail() {
  const can = useSession((s) => s.can);
  const pending = useVisionLive((s) => s.pendingReview);
  const open = useUi((s) => s.railOpen);
  const toggle = useUi((s) => s.toggleRail);
  const alerts = useData((s) => s.alerts);
  const critical = useMemo(() => alerts.filter((a) => a.status === 'open' && a.priority === 'critical').length, [alerts]);
  return (
    <nav className={`rail ${open ? 'open' : ''}`} aria-label="Application areas">
      {NAV.map((g) => {
        const items = g.items.filter((n) => !n.perm || can(n.perm));
        if (!items.length) return null;
        return (
          <div key={g.group} style={{ display: 'contents' }}>
            <div className="rail-group">
              <span>{g.group}</span>
            </div>
            {items.map((n) => {
              const I = Icon[n.icon] as () => ReactNode;
              const badge = n.to === '/identity' && pending > 0 ? pending : n.to === '/operations' && critical > 0 ? critical : 0;
              return (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')} aria-label={n.label}>
                  <I />
                  <span className="lbl">{n.label}</span>
                  {badge > 0 && <span className={`rail-badge ${n.to === '/operations' ? 'red' : ''}`}>{badge > 99 ? '99+' : badge}</span>}
                  <span className="tip">{n.label}</span>
                </NavLink>
              );
            })}
          </div>
        );
      })}
      <button className="rail-toggle" onClick={toggle} aria-label={open ? 'Collapse navigation' : 'Expand navigation'} title={open ? 'Collapse' : 'Expand'}>
        <Icon.Chevron />
        {open && <span className="lbl" style={{ fontSize: 12 }}>Collapse</span>}
      </button>
    </nav>
  );
}

const TOAST_MS = { high: 9000, critical: 0 } as const;

/** New critical/high alerts as toasts: critical ones stay until dismissed or acknowledged. */
function Toasts() {
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
            {a.priority} · {a.rule.replace(/_/g, ' ')}
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
      <span className="spinner" style={{ borderTopColor: '#fff', width: 12, height: 12 }} />
      Live connection lost — reconnecting. The picture is not updating.
    </div>
  );
}

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const localFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });
const localTime = (t: number) => localFmt.format(new Date(t));

function Clock() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);
  const { mode, t, rate, direction, playing } = useTime.getState();
  const edge = useTime.getState().currentLiveEdge();
  const lag = Math.max(0, Date.now() - edge);
  return (
    <div className="clock" data-mode={mode}>
      <span className={`clock-mode ${mode}`}>
        {mode === 'live' && <span className="live-dot" style={{ width: 6, height: 6 }} />}
        {mode === 'live' ? 'LIVE' : playing ? `${direction < 0 ? '◀ ' : ''}×${rate}` : 'PAUSED'}
      </span>
      <span className="mono clock-t">{dateTime(mode === 'live' ? edge : t)}</span>
      <span className="mono clock-local" title={`Local time (${LOCAL_TZ})`}>
        {localTime(mode === 'live' ? edge : t)}
      </span>
      {mode === 'live' ? (
        <span className="dim mono" title="Age of the newest processed observation">
          +{(lag / 1000).toFixed(1)}s
        </span>
      ) : (
        <span className="dim mono">−{Math.round((edge - t) / 60000)} min</span>
      )}
    </div>
  );
}

function SearchBox() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ kind: string; id: string; label: string; detail: string }[]>([]);
  const [open, setOpen] = useState(false);
  const facility = useWorld((s) => s.facility);
  const nav = useNavigate();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => {
    if (q.trim().length < 1) {
      setRes([]);
      return;
    }
    const ctl = new AbortController();
    const id = setTimeout(() => {
      const grid = /^\s*\d{1,2}\s*[C-HJ-NP-X]\s*[A-HJ-NP-Z]{2}\s*\d{2,10}\s*\d*\s*$/i.test(q) ? [{ kind: 'mgrs', id: q.trim(), label: `Grid ${q.trim().toUpperCase()}`, detail: 'MGRS — fly to' }] : [];
      get<typeof res>(`/api/search?q=${encodeURIComponent(q.trim())}`, ctl.signal)
        .then((r) => setRes([...grid, ...r]))
        .catch(() => setRes(grid));
    }, 150);
    return () => {
      clearTimeout(id);
      ctl.abort();
    };
  }, [q]);
  const choose = (r: (typeof res)[number]) => {
    const w = useWorld.getState();
    setOpen(false);
    setQ('');
    if (r.kind === 'incident') {
      nav(`/incidents/${r.id}`);
      return;
    }
    nav('/operations');
    if (r.kind === 'mgrs' && facility) {
      try {
        const g = fromMgrs(r.id);
        const p = new EnuFrame(facility.origin).toEnu({ lat: g.lat, lon: g.lon, alt: 0 });
        const z = terrainHeight(p.x, p.y);
        w.flyTo({ x: p.x, y: p.y, z }, Math.max(200, g.precisionM * 2));
        w.select({ kind: 'point', position: { x: p.x, y: p.y, z } });
      } catch {
        /* invalid reference */
      }
      return;
    }
    if (r.kind === 'coordinates' && facility) {
      const [a, b] = r.id.split(',').map(Number) as [number, number];
      const isGeo = r.label.includes('.') && Math.abs(a) <= 90 && Math.abs(b) <= 180 && Math.abs(a) < 1 && Math.abs(b) < 1;
      const p = isGeo ? new EnuFrame(facility.origin).toEnu({ lat: a, lon: b, alt: 0 }) : { x: a, y: b, z: 0 };
      w.flyTo({ x: p.x, y: p.y, z: terrainHeight(p.x, p.y) }, 300);
      w.select({ kind: 'point', position: { x: p.x, y: p.y, z: terrainHeight(p.x, p.y) } });
      return;
    }
    if (r.kind === 'building' && facility) {
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
  };
  return (
    <div className="search">
      <Icon.Search />
      <input
        ref={ref}
        className="search-input"
        placeholder="Search site, sensor, track, incident, or E,N / lat,lon"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && res[0]) choose(res[0]);
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }}
        aria-label="Search"
      />
      <span className="kbd">Ctrl K</span>
      {open && res.length > 0 && (
        <div className="search-results reveal" role="listbox">
          {res.map((r) => (
            <div key={`${r.kind}:${r.id}`} className="list-row" role="option" aria-selected={false} onMouseDown={() => choose(r)}>
              <span className="upper dim" style={{ width: 74 }}>
                {r.kind}
              </span>
              <span className="grow ellipsis">{r.label}</span>
              <span className="dim">{r.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusSummary() {
  const alerts = useData((s) => s.alerts);
  const sensors = useData((s) => s.sensors);
  const ws = useData((s) => s.wsStatus);
  const nav = useNavigate();
  const open = useMemo(() => alerts.filter((a) => a.status === 'open'), [alerts]);
  const crit = open.filter((a) => a.priority === 'critical').length;
  const high = open.filter((a) => a.priority === 'high').length;
  const down = Object.values(sensors).filter((s) => s.status === 'silent' || s.status === 'offline' || s.status === 'fault').length;
  return (
    <div className="row status-sum">
      <button className="btn ghost small" onClick={() => nav('/operations')} title="Open alerts">
        <span className="prio critical" /> {crit}
        <span className="prio high" style={{ marginLeft: 6 }} /> {high}
        <span className="dim">open {open.length}</span>
      </button>
      <button className="btn ghost small" onClick={() => nav('/sensors')} title="Sensors not reporting">
        <span className={`status-dot ${down ? 'silent' : 'ok'}`} /> {down ? `${down} sensor${down > 1 ? 's' : ''} down` : 'sensors nominal'}
      </button>
      <span className="row dim" title="Live data connection" style={{ fontSize: 11.5 }}>
        <span className={`status-dot ${ws === 'open' ? 'ok' : ws === 'connecting' ? 'degraded' : 'silent'}`} />
        {ws === 'open' ? 'live' : ws}
      </span>
    </div>
  );
}

function TopBar() {
  const facility = useWorld((s) => s.facility);
  const readiness = useOps((s) => s.readiness);
  const mode = useWorld((s) => s.mode);
  const setMode = useWorld((s) => s.setMode);
  const loc = useLocation();
  const nav = useNavigate();
  const onWorld = loc.pathname.startsWith('/operations');
  const pick = (m: GlobalMode) => {
    setMode(m);
    const time = useTime.getState();
    if (m === 'NOW') time.goLive();
    if (m === 'HISTORY' && time.mode === 'live') time.seek(time.currentLiveEdge() - 15 * 60_000);
    if (!onWorld) nav('/operations');
  };
  return (
    <header className="topbar">
      <NavLink to="/operations" className="brand" aria-label="Strata — operational picture">
        <Icon.Logo />
        <span className="wordmark">STRATA</span>
      </NavLink>
      <div className="site">
        <b>{facility?.name.split(' — ')[0] ?? 'Site'}</b>
        <span>{facility?.name.split(' — ')[1] ?? ''}</span>
      </div>
      {readiness && (
        <button className={`readiness r-${readiness.level.replace(' ', '-')}`} onClick={() => nav('/command')} title={`Readiness set ${new Date(readiness.t || Date.now()).toISOString().slice(0, 16)}Z by ${readiness.by}: ${readiness.reason}`}>
          {readiness.level}
        </button>
      )}
      {onWorld && (
        <div className="seg modes" role="tablist" aria-label="Global mode">
          {MODES.map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => pick(m)}>
              {m}
            </button>
          ))}
        </div>
      )}
      <Clock />
      <SearchBox />
      <div className="spacer" />
      <StatusSummary />
      <UserMenu />
    </header>
  );
}

function UserMenu() {
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const sound = useOps((s) => s.sound);
  const setSound = useOps((s) => s.setSound);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const initials = (user?.displayName ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="row" style={{ gap: 6, flex: 'none' }}>
      <button className={`btn ghost small icon ${sound ? '' : 'muted'}`} onClick={() => setSound(!sound)} title={sound ? 'Alarm sound on (critical/high alerts) — click to mute' : 'Alarm sound muted — click to enable'} aria-label={sound ? 'Mute alarm sound' : 'Enable alarm sound'} aria-pressed={sound}>
        {sound ? <Icon.Bell /> : <Icon.BellOff />}
      </button>
      <div className="menu-anchor" ref={ref}>
        <button className="btn ghost user-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
          <span className="avatar">{initials}</span>
          <span className="col user-meta" style={{ gap: 0, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 12 }}>{user?.displayName}</span>
            <span className="upper dim" style={{ fontSize: 9.5 }}>
              {user?.role}
            </span>
          </span>
        </button>
        {open && (
          <div className="menu" role="menu">
            <div className="m-head">
              <div style={{ fontWeight: 500 }}>{user?.displayName}</div>
              <div className="muted mono" style={{ fontSize: 11 }}>
                {user?.username} · {user?.role}
              </div>
            </div>
            <button className="m-item" role="menuitem" onClick={() => setTheme(theme === 'night' ? 'dark' : 'night')}>
              {theme === 'night' ? <Icon.Sun /> : <Icon.Moon />}
              <span className="grow">{theme === 'night' ? 'Standard display' : 'Night display (red light)'}</span>
            </button>
            <button className="m-item" role="menuitem" onClick={() => setSound(!sound)}>
              {sound ? <Icon.BellOff /> : <Icon.Bell />}
              <span className="grow">{sound ? 'Mute alarm sound' : 'Enable alarm sound'}</span>
            </button>
            <div className="m-sep" />
            <button className="m-item" role="menuitem" onClick={() => void logout()}>
              <Icon.SignOut />
              <span className="grow">Sign out</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
