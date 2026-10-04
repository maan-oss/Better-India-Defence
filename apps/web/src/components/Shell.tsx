import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../state/session';
import { MODES, useWorld, type GlobalMode } from '../state/world';
import { useTime } from '../state/time';
import { useData } from '../state/data';
import { get } from '../api/client';
import { Icon } from './Icons';
import { dateTime } from '../lib/format';
import { EnuFrame, terrainHeight } from '@strata/domain';

const NAV: { to: string; label: string; icon: keyof typeof Icon; perm?: string }[] = [
  { to: '/operations', label: 'Operations', icon: 'Ops' },
  { to: '/incidents', label: 'Incidents', icon: 'Incidents' },
  { to: '/sensors', label: 'Sensors', icon: 'Sensors' },
  { to: '/reconstructions', label: 'Reconstructions', icon: 'Recon' },
  { to: '/evidence', label: 'Evidence', icon: 'Evidence' },
  { to: '/simulation', label: 'Simulation Lab', icon: 'Sim', perm: 'simulation.control' },
  { to: '/system', label: 'System Health', icon: 'Health', perm: 'system.view' },
  { to: '/audit', label: 'Audit', icon: 'Audit', perm: 'audit.view' },
  { to: '/admin', label: 'Administration', icon: 'Admin', perm: 'admin.users' },
];

export function Shell({ children }: { children: ReactNode }) {
  const can = useSession((s) => s.can);
  return (
    <div className="shell">
      <TopBar />
      <nav className="rail" aria-label="Application areas">
        {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => {
          const I = Icon[n.icon];
          return (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')} aria-label={n.label}>
              <I />
              <span className="tip">{n.label}</span>
            </NavLink>
          );
        })}
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}

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
      <span className={`clock-mode ${mode}`}>{mode === 'live' ? 'LIVE' : playing ? `${direction < 0 ? '◀ ' : ''}×${rate}` : 'PAUSED'}</span>
      <span className="mono clock-t">{dateTime(mode === 'live' ? edge : t)}</span>
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
      get<typeof res>(`/api/search?q=${encodeURIComponent(q.trim())}`, ctl.signal)
        .then(setRes)
        .catch(() => undefined);
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
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const mode = useWorld((s) => s.mode);
  const setMode = useWorld((s) => s.setMode);
  const loc = useLocation();
  const nav = useNavigate();
  const pick = (m: GlobalMode) => {
    setMode(m);
    const time = useTime.getState();
    if (m === 'NOW') time.goLive();
    if (m === 'HISTORY' && time.mode === 'live') time.seek(time.currentLiveEdge() - 15 * 60_000);
    if (!loc.pathname.startsWith('/operations')) nav('/operations');
  };
  return (
    <header className="topbar">
      <div className="brand" aria-label="Strata">
        <Icon.Logo />
      </div>
      <div className="site">
        <b>Site KESTREL</b>
        <span>Synthetic test facility · 5.1 × 5.1 km</span>
      </div>
      <div className="seg modes" role="tablist" aria-label="Global mode">
        {MODES.map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => pick(m)}>
            {m}
          </button>
        ))}
      </div>
      <Clock />
      <SearchBox />
      <div className="spacer" />
      <StatusSummary />
      <div className="row user">
        <div className="col" style={{ gap: 0, alignItems: 'flex-end' }}>
          <span style={{ fontSize: 12 }}>{user?.displayName}</span>
          <span className="upper dim">{user?.role}</span>
        </div>
        <button className="btn small ghost" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </header>
  );
}
