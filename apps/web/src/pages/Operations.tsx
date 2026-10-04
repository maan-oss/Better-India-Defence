import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { getCameras, terrainHeight } from '@strata/domain';
import { WorldEngine } from '../engine/WorldEngine';
import { useWorld } from '../state/world';
import { useTime } from '../state/time';
import { useData } from '../state/data';
import { useOps } from '../state/ops';
import { EnuFrame } from '@strata/domain';
import { tracks } from '../state/tracks';
import { live } from '../api/live';
import { get, qs } from '../api/client';
import { LayersPanel } from '../components/LayersPanel';
import { ContextPanel } from '../components/ContextPanel';
import { Timeline } from '../components/Timeline';
import { MapHud } from '../components/MapHud';
import { Copilot } from '../components/Copilot';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { StateChip } from '../components/common';
import { hms } from '../lib/format';

const now = () => {
  const s = useTime.getState();
  return s.mode === 'live' ? s.currentLiveEdge() : s.t;
};

/** OPERATIONS — the primary 4D world. */
export function Operations() {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<WorldEngine | null>(null);
  const facility = useWorld((s) => s.facility);
  const patches = useWorld((s) => s.patches);
  const mode = useWorld((s) => s.mode);
  const viewThrough = useWorld((s) => s.viewThrough);
  const incidentId = useWorld((s) => s.incidentId);
  const diffShow = useWorld((s) => s.diffShow);
  const [introFade, setIntroFade] = useState(1);
  const [stats, setStats] = useState('');
  const [webglError, setWebglError] = useState<string | null>(null);

  // Engine lifecycle.
  useEffect(() => {
    if (!facility || !hostRef.current || !labelRef.current) return;
    let engine: WorldEngine;
    let withIntro = false;
    try {
      withIntro = sessionStorage.getItem('strata.intro') !== 'done';
    } catch {
      withIntro = false;
    }
    try {
      engine = new WorldEngine(hostRef.current, labelRef.current, facility, patches, withIntro);
    } catch (e) {
      setWebglError(e instanceof Error ? e.message : 'WebGL unavailable');
      return;
    }
    engineRef.current = engine;
    const ortho = useWorld.getState().orthophoto;
    if (ortho) {
      const fr = new EnuFrame(facility.origin);
      const sw = fr.toEnu({ lat: ortho.bounds.south, lon: ortho.bounds.west, alt: 0 });
      const ne = fr.toEnu({ lat: ortho.bounds.north, lon: ortho.bounds.east, alt: 0 });
      engine.setOrthophoto(ortho.url, { x0: sw.x, y0: sw.y, x1: ne.x, y1: ne.y });
    }
    engine.setGridFrame(facility.origin);
    const host = hostRef.current;
    const afterIntro = () => {
      try {
        sessionStorage.setItem('strata.intro', 'done');
      } catch {
        /* storage unavailable */
      }
      setIntroFade(0);
      engine.flyTo({ x: 0, y: -150, z: 0 }, 3200, 20, -42);
    };
    if (withIntro) {
      host.addEventListener('intro-done', afterIntro, { once: true });
      setIntroFade(0);
    } else {
      setIntroFade(0);
      engine.flyTo({ x: 0, y: -150, z: 0 }, 3200, 20, -42);
    }
    engine.getTime = now;
    engine.getTracks = (t) => {
      if (useTime.getState().mode === 'live') return tracks.liveAt(t);
      tracks.ensure(t);
      return tracks.replayAt(t);
    };
    engine.onPick = (s) => {
      useWorld.getState().select(s);
      if (s?.kind === 'track') {
        const p = engine.trackPosition(s.id);
        if (p) engine.flyTo({ x: p.x, y: p.y, z: p.z }, 180);
      }
    };
    engine.onHover = (s) => useWorld.getState().setHover(s);
    engine.extraLabels = () => {
      const out = [];
      const cam = engine.camera.position;
      for (const b of facility.buildings) {
        const p = new THREE.Vector3(b.center.x, b.center.y, terrainHeight(b.center.x, b.center.y) + b.height + 4);
        const d = p.distanceTo(cam);
        if (d > 1300 || b.kind === 'shelter' || b.kind === 'gatehouse') continue;
        out.push({ id: `b:${b.id}`, position: p, text: `${b.label} · ${b.name}`, tone: 'building' as const, priority: 4 });
      }
      return out;
    };
    // Apply current store state.
    const w = useWorld.getState();
    engine.setLayers(w.layers);
    engine.setNav(w.nav);
    const unsub = useWorld.subscribe((s, prev) => {
      if (s.layers !== prev.layers) engine.setLayers(s.layers);
      if (s.nav !== prev.nav) engine.setNav(s.nav);
      if (s.selection !== prev.selection) engine.setSelection(s.selection);
      if (s.fly && s.fly !== prev.fly) engine.flyTo(s.fly.position, s.fly.distance, s.fly.headingDeg, s.fly.pitchDeg);
      if (s.viewThrough !== prev.viewThrough) engine.viewThrough(s.viewThrough ? (getCameras().find((c) => c.id === s.viewThrough) ?? null) : null);
    });
    // Time engine clock.
    let raf = 0;
    let last = performance.now();
    const tick = (n: number) => {
      raf = requestAnimationFrame(tick);
      useTime.getState().advance(n - last);
      last = n;
    };
    raf = requestAnimationFrame(tick);
    const statsId = setInterval(() => {
      const st = engine.stats;
      setStats(`${st.fps} fps · ${st.frameMs} ms · ${st.drawCalls} draws · ${(st.triangles / 1000).toFixed(0)}k tris · ${st.tracks} tracks`);
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(statsId);
      unsub();
      engine.dispose();
      engineRef.current = null;
    };
  }, [facility, patches]);

  // Periodic data synchronisation for the current time.
  useEffect(() => {
    let lastReplayT = -1;
    let lastReplayAt = 0;
    let lastCovT = -1;
    let lastCovAt = 0;
    let lastRfAt = 0;
    let busyReplay = false;
    let busyCov = false;
    const rfLive: { x: number; y: number; r: number; at: number }[] = [];
    const offObs = live.on((m) => {
      if (m.type !== 'observations') return;
      for (const o of m.observations) if (o.kind === 'rf' && o.position) rfLive.push({ x: o.position.x, y: o.position.y, r: 250, at: o.t });
      while (rfLive.length > 200) rfLive.shift();
    });
    const sync = async () => {
      const engine = engineRef.current;
      if (!engine) return;
      const t = now();
      const time = useTime.getState();
      const w = useWorld.getState();
      const d = useData.getState();
      const isLive = time.mode === 'live';
      // Replay state (structures, objects, sensor status, infrastructure) at t.
      if (!busyReplay && ((isLive && Date.now() - lastReplayAt > 5000) || (!isLive && Math.abs(t - lastReplayT) > 1500))) {
        busyReplay = true;
        lastReplayT = t;
        lastReplayAt = Date.now();
        d.loadReplayState(t)
          .then(() => {
            const r = useData.getState().replay;
            if (!r || !engineRef.current) return;
            engineRef.current.setStructures(r.structures);
            engineRef.current.setObjects(r.objects);
            engineRef.current.setInfrastructure(isLive ? { ...r.infrastructure, ...useData.getState().infra } : r.infrastructure);
            const status: Record<string, string> = {};
            for (const [k, v] of Object.entries(r.sensors)) status[k] = v.status;
            if (isLive) for (const [k, v] of Object.entries(useData.getState().sensors)) status[k] = v.status;
            engineRef.current.setSensorStatus(status);
          })
          .catch(() => undefined)
          .finally(() => (busyReplay = false));
      }
      // Coverage / uncertainty.
      const wantCov = w.layers.uncertainty || w.mode === 'COVERAGE' || w.mode === 'EVIDENCE';
      if (wantCov && !busyCov && (Math.abs(t - lastCovT) > (isLive ? 30_000 : 4000) || Date.now() - lastCovAt > 30_000)) {
        busyCov = true;
        lastCovT = t;
        lastCovAt = Date.now();
        d.loadCoverage(t)
          .catch(() => undefined)
          .finally(() => (busyCov = false));
      }
      engine.setPatchMode(w.mode === 'EVIDENCE' ? 'state' : wantCov ? 'support' : 'off', useData.getState().coverage);
      engine.setAlerts(d.alerts, t);
      const changes = w.mode === 'DIFF' && w.diff ? d.changes.filter((c) => c.t > Math.min(w.diff!.a, w.diff!.b) && c.t <= Math.max(w.diff!.a, w.diff!.b)) : d.changes.filter((c) => c.t <= t && c.t > t - 3 * 3600_000);
      engine.setChanges(changes, w.selection?.kind === 'change' ? new Set([w.selection.id]) : null);
      engine.setIncidents(d.incidents, w.incidentId, null);
      const ops = useOps.getState();
      engine.setThreat(w.layers.zones ? ops.vitalAssets : [], isLive && w.layers.zones ? ops.threats : []);
      // RF evidence regions.
      if (w.layers.rf) {
        if (isLive) engine.setRf(rfLive.map((g) => ({ x: g.x, y: g.y, r: g.r, age: t - g.at })));
        else if (Date.now() - lastRfAt > 1500) {
          lastRfAt = Date.now();
          get<{ x: number; y: number; r: number; t: number }[]>(`/api/replay/observations?${qs({ kind: 'rf', from: Math.round(t - 12_000), to: Math.round(t) })}`)
            .then((rows) => engineRef.current?.setRf(rows.map((r) => ({ x: r.x, y: r.y, r: r.r, age: t - r.t }))))
            .catch(() => undefined);
        }
      }
      // Projected camera feed.
      const sel = w.selection;
      if (w.projectFeed && sel?.kind === 'sensor') {
        const cam = getCameras().find((c) => c.id === sel.id);
        engine.setFeedProjection(cam ?? null, cam ? `/api/media/frame?${qs({ sensorId: cam.id, t: Math.floor(t / 2000) * 2000 })}` : null);
      } else engine.setFeedProjection(null, null);
    };
    const id = setInterval(() => void sync(), 700);
    void sync();
    return () => {
      clearInterval(id);
      offObs();
    };
  }, []);

  // Recorded changes list (refreshed).
  useEffect(() => {
    const load = () => {
      const t = useTime.getState();
      void useData.getState().loadChanges(t.rangeFrom || t.currentLiveEdge() - 3 * 3600_000, t.currentLiveEdge() + 60_000).catch(() => undefined);
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      const time = useTime.getState();
      if (e.key === ' ') {
        e.preventDefault();
        time.togglePlay();
      } else if (e.key === 'ArrowLeft') time.step(e.shiftKey ? -10 : -1);
      else if (e.key === 'ArrowRight') time.step(e.shiftKey ? 10 : 1);
      else if (e.key === 'Escape') {
        const w = useWorld.getState();
        if (w.viewThrough) w.setViewThrough(null);
        else w.select(null);
      } else if (e.key.toLowerCase() === 'l' && !e.ctrlKey) time.goLive();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // Modes that imply time behaviour.
  useEffect(() => {
    if (mode === 'NOW') useTime.getState().goLive();
  }, [mode]);

  const tmode = useTime((s) => s.mode);
  const banner =
    mode === 'INCIDENT' && incidentId ? (
      <span>
        <StateChip state="RECONSTRUCTED" label="incident reconstruction" /> replaying recorded evidence
      </span>
    ) : mode === 'DIFF' ? (
      <span>
        REALITY DIFF · world shows <b>{diffShow}</b>
      </span>
    ) : mode === 'COVERAGE' ? (
      <span>COVERAGE · observation support · hatched = never observed</span>
    ) : mode === 'EVIDENCE' ? (
      <span>EVIDENCE · select any surface for its ledger</span>
    ) : tmode === 'replay' ? (
      <span>
        HISTORY · recorded state at <span className="mono">{hms(useTime.getState().t)}Z</span>
      </span>
    ) : null;

  return (
    <div className="ops">
      <LayersPanel />
      <section className="ops-world" aria-label="4D world">
        {webglError ? (
          <div className="err">3D world unavailable: {webglError}. All other areas remain usable.</div>
        ) : (
          <>
            <div ref={hostRef} className="world-canvas" />
            <div ref={labelRef} className="world-labels" />
            <div className="intro-fade" style={{ opacity: introFade }} />
            {facility && <MapHud engineRef={engineRef} hostRef={hostRef} facility={facility} />}
          </>
        )}
        {banner && <div className="mode-banner glass">{banner}</div>}
        {viewThrough && (
          <div className="world-hud glass" style={{ padding: '6px 10px' }}>
            Viewing reconstructed world from <b className="mono">{viewThrough}</b> calibrated pose
            <button className="btn small" onClick={() => useWorld.getState().setViewThrough(null)}>
              Exit (Esc)
            </button>
          </div>
        )}
        <div className="perf" aria-hidden>
          {stats}
        </div>
        <ErrorBoundary area="Copilot">
          <Copilot />
        </ErrorBoundary>
      </section>
      <ContextPanel />
      <section className="ops-bottom" aria-label="Timeline">
        <Timeline />
      </section>
    </div>
  );
}
