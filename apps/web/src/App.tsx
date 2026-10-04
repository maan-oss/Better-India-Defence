import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './state/session';
import { useWorld } from './state/world';
import { useTime } from './state/time';
import { useData } from './state/data';
import { tracks } from './state/tracks';
import { live } from './api/live';
import { useVisionLive } from './api/vision';
import { get, setUnauthorizedHandler } from './api/client';
import type { FacilityResponse } from './api/types';
import type { SurfacePatch } from '@strata/domain';
import { Login } from './pages/Login';
import { Shell } from './components/Shell';
import { ErrorBoundary } from './components/ErrorBoundary';

const Operations = lazy(() => import('./pages/Operations').then((m) => ({ default: m.Operations })));
const Incidents = lazy(() => import('./pages/Incidents').then((m) => ({ default: m.Incidents })));
const Sensors = lazy(() => import('./pages/Sensors').then((m) => ({ default: m.Sensors })));
const Reconstructions = lazy(() => import('./pages/Reconstructions').then((m) => ({ default: m.Reconstructions })));
const Evidence = lazy(() => import('./pages/Evidence').then((m) => ({ default: m.Evidence })));
const SimulationLab = lazy(() => import('./pages/SimulationLab').then((m) => ({ default: m.SimulationLab })));
const SystemHealth = lazy(() => import('./pages/SystemHealth').then((m) => ({ default: m.SystemHealth })));
const Audit = lazy(() => import('./pages/Audit').then((m) => ({ default: m.Audit })));
const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })));
const Forensics = lazy(() => import('./pages/Forensics').then((m) => ({ default: m.Forensics })));
const Cameras = lazy(() => import('./pages/Cameras').then((m) => ({ default: m.Cameras })));
const Identity = lazy(() => import('./pages/Identity').then((m) => ({ default: m.Identity })));

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
        useWorld.getState().setFacility(f.facility, p.patches);
        useTime.getState().setLiveEdge(f.liveEdge || Date.now());
        if (f.range.from) useTime.getState().setRange(f.range.from);
        useTime.setState({ t: f.liveEdge || Date.now() });
        await useData.getState().loadInitial();
        void useVisionLive.getState().refreshCounts();
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
  if (error) return <div className="err">Failed to load the facility model: {error}</div>;
  if (!ready) return <div className="boot">Loading world memory…</div>;
  return (
    <Shell>
      <ErrorBoundary area="Application area">
        <Suspense fallback={<div className="boot">Loading…</div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/operations" replace />} />
            <Route path="/operations" element={<Operations />} />
            <Route path="/incidents" element={<Incidents />} />
            <Route path="/incidents/:id" element={<Incidents />} />
            <Route path="/sensors" element={<Sensors />} />
            <Route path="/sensors/:id" element={<Sensors />} />
            <Route path="/reconstructions" element={<Reconstructions />} />
            <Route path="/reconstructions/:id" element={<Reconstructions />} />
            <Route path="/evidence" element={<Evidence />} />
            <Route path="/forensics" element={<Forensics />} />
            <Route path="/forensics/:id" element={<Forensics />} />
            <Route path="/identity" element={<Identity />} />
            <Route path="/cameras" element={<Cameras />} />
            <Route path="/simulation" element={<SimulationLab />} />
            <Route path="/system" element={<SystemHealth />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="*" element={<Navigate to="/operations" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </Shell>
  );
}

export function App() {
  const status = useSession((s) => s.status);
  const refresh = useSession((s) => s.refresh);
  useEffect(() => {
    void refresh();
    setUnauthorizedHandler(() => void refresh());
  }, [refresh]);
  if (status === 'unknown') return <div className="boot">Strata</div>;
  return (
    <BrowserRouter>
      <ErrorBoundary area="Strata">{status === 'authenticated' ? <Authenticated /> : <Login />}</ErrorBoundary>
    </BrowserRouter>
  );
}
