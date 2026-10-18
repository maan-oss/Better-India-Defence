import { Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './state/session';
import { SecondFactor } from './pages/SecondFactor';
import { useWorld } from './state/world';
import { useTime } from './state/time';
import { useData } from './state/data';
import { tracks } from './state/tracks';
import { live } from './api/live';
import { useVisionLive } from './api/vision';
import { useOps } from './state/ops';
import { get, setUnauthorizedHandler } from './api/client';
import type { FacilityResponse } from './api/types';
import { FACILITY, setTerrainMode, type SurfacePatch } from '@strata/domain/client';
import { Login } from './pages/Login';
import { type SetupStatus } from './pages/Setup';
import { Shell } from './components/Shell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Mark } from './brand/Mark';
import { BootMark, BootScreen, Empty, NotFound } from './brand/Boot';
import { Gate } from './components/Gate';
import { lazyPage, warmCorePages } from './routes';

const Operations = lazyPage('operations');
const Incidents = lazyPage('incidents');
const Sensors = lazyPage('sensors');
const Assets = lazyPage('assets');
const Reconstructions = lazyPage('reconstructions');
const Evidence = lazyPage('evidence');
const SimulationLab = lazyPage('simulationLab');
const SystemHealth = lazyPage('systemHealth');
const Audit = lazyPage('audit');
const DeviceCamera = lazyPage('deviceCamera');
const Brand = lazyPage('brand');
const Admin = lazyPage('admin');
const Forensics = lazyPage('forensics');
const Command = lazyPage('command');
const SiteSetup = lazyPage('siteSetup');
const Setup = lazyPage<{ status: SetupStatus }>('setup');

/** First-run wizard in its own chunk: signed-in users on a configured site never download it. */
function SetupRoute({ status }: { status: SetupStatus }) {
  return (
    <Suspense fallback={<div className="route-loading"><BootMark size={36} /></div>}>
      <Setup status={status} />
    </Suspense>
  );
}
const Cameras = lazyPage('cameras');
const Field = lazyPage('field');
const Identity = lazyPage('identity');

/** Connects live data once signed in and loads the facility model. */
function useBootstrap(enabled: boolean): { ready: boolean; error: string | null } {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const [f, p] = await Promise.all([get<FacilityResponse>('/api/facility'), get<{ patches: SurfacePatch[] }>('/api/world/patches')]);
        if (cancelled) return;
        // The server's site model replaces the bundled demo model everywhere in the client.
        Object.assign(FACILITY, f.facility);
        setTerrainMode(f.terrain);
        useWorld.setState({ orthophoto: f.orthophoto, basemap: f.basemap ?? null, runMode: f.mode ?? 'operational', simulated: f.simulated });
        useWorld.getState().setFacility(f.facility, p.patches);
        useTime.getState().setLiveEdge(f.liveEdge || Date.now());
        if (f.range.from) useTime.getState().setRange(f.range.from);
        useTime.setState({ t: f.liveEdge || Date.now() });
        await useData.getState().loadInitial();
        void useVisionLive.getState().refreshCounts();
        await useOps.getState().load();
        for (const a of useData.getState().alerts) useOps.getState().seenAlerts.add(a.id);
        setReady(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    const offMsg = live.on((m) => {
      if (m.type === 'tracks') tracks.ingestLive(m.t, m.tracks);
      else if (m.type === 'tick' || m.type === 'hello') useTime.getState().setLiveEdge(m.liveEdge);
      else {
        useData.getState().onLive(m);
        useVisionLive.getState().onLive(m);
        useOps.getState().onLive(m);
      }
    });
    const offStatus = live.onStatus((s) => useData.getState().setWs(s));
    live.start();
    return () => {
      cancelled = true;
      offMsg();
      offStatus();
      live.stop();
    };
  }, [enabled]);
  return { ready, error };
}

function Authenticated() {
  const { ready, error } = useBootstrap(true);
  if (error)
    return (
      <div className="boot">
        <div className="boot-card">
          <Mark size={36} />
          <div className="err" style={{ margin: 0 }}>
            Failed to load the facility model: {error}
          </div>
          <button className="btn" onClick={() => location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  if (!ready) return <Boot label="Loading site model and recorded state" />;
  return (
    <Shell>
      <ErrorBoundary area="Application area">
        <Suspense fallback={<div className="route-loading"><BootMark size={36} /></div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/operations" replace />} />
            <Route path="/operations" element={<Operations />} />
            <Route path="/incidents" element={<Incidents />} />
            <Route path="/incidents/:id" element={<Incidents />} />
            <Route path="/sensors" element={<Sensors />} />
            <Route path="/sensors/:id" element={<Sensors />} />
            <Route path="/assets" element={<Assets />} />
            <Route path="/assets/:id" element={<Assets />} />
            <Route path="/reconstructions" element={<Reconstructions />} />
            <Route path="/reconstructions/:id" element={<Reconstructions />} />
            <Route path="/evidence" element={<Evidence />} />
            <Route path="/forensics" element={<Forensics />} />
            <Route path="/forensics/:id" element={<Forensics />} />
            <Route path="/identity" element={<Identity />} />
            <Route path="/cameras" element={<Cameras />} />
            <Route path="/cameras/:id/stream" element={<DeviceCamera />} />
            <Route path="/command" element={<Command />} />
            <Route path="/field" element={<Field />} />
            <Route path="/site" element={<Gate need="admin.config"><SiteSetup /></Gate>} />
            <Route path="/simulation" element={<SimulationLab />} />
            <Route path="/system" element={<SystemHealth />} />
            <Route path="/audit" element={<Gate need="audit.view"><Audit /></Gate>} />
            <Route path="/admin" element={<Gate need="admin.users"><Admin /></Gate>} />
            <Route path="/brand" element={<Brand />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </Shell>
  );
}

const Boot = ({ label }: { label: string }) => <BootScreen label={label} />;

export function App() {
  const status = useSession((s) => s.status);
  const mustEnrol = useSession((s) => s.mustEnrol);
  const role = useSession((s) => s.user?.role);
  const refresh = useSession((s) => s.refresh);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  useEffect(() => {
    // Warm the core pages' code once the browser is idle, so the first navigation has nothing to wait for.
    if (status !== 'authenticated') return;
    const id = window.requestIdleCallback(warmCorePages, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }, [status]);
  useEffect(() => {
    void refresh();
    setUnauthorizedHandler(() => void refresh());
    get<SetupStatus>('/api/setup/status')
      .then(setSetup)
      .catch((e: unknown) => setSetupError(e instanceof Error ? e.message : String(e)));
  }, [refresh]);
  if (setupError) return <Boot label={`Cannot reach the Strata service: ${setupError}`} />;
  if (status === 'unknown' || !setup) return <Boot label="Connecting" />;
  // First run of an operational install: the wizard creates the administrator, then the site.
  if (setup.needsAdmin) return <SetupRoute status={setup} />;
  if (setup.needsSite && status === 'authenticated') {
    if (role === 'administrator') return <SetupRoute status={setup} />;
    return (
      <div className="waiting-setup">
        <Empty
          art="site"
          title="The site has not been set up yet"
          description="An administrator needs to define the installation before the operational picture can start. Sign in as an administrator, or ask yours to finish setup."
          action={
            <button className="btn" onClick={() => void useSession.getState().logout()}>
              Sign out
            </button>
          }
        />
      </div>
    );
  }
  // Navigation is a plain update, not a transition: React holds back a transition's Suspense reveal for ~300 ms.
  return (
    <BrowserRouter useTransitions={false}>
      <ErrorBoundary area="Strata">{status === 'authenticated' ? (mustEnrol ? <SecondFactor /> : <Authenticated />) : <Login />}</ErrorBoundary>
    </BrowserRouter>
  );
}
