import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { getCameras, terrainHeight } from "@strata/domain";
import { WorldEngine } from "../engine/WorldEngine";
import { useWorld } from "../state/world";
import { useTime } from "../state/time";
import { useData } from "../state/data";
import { useOps } from "../state/ops";
import { EnuFrame } from "@strata/domain";
import { tracks } from "../state/tracks";
import { live } from "../api/live";
import { get, qs } from "../api/client";
import { ContextPanel } from "../components/ContextPanel";
import { Timeline } from "../components/Timeline";
import { MapHud } from "../components/MapHud";
import { Copilot } from "../components/Copilot";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { StateChip } from "../components/common";
import { hms } from "../lib/format";
import { buildBasemap } from "../lib/basemap";
import {
  BottomSheet,
  ResizablePanel,
  ResizablePanels,
} from "../components/kit";
import { ModeControl, ToolDock } from "../components/ops/MapControls";
import { GetStarted } from "../components/ops/GetStarted";

const now = () => {
  const s = useTime.getState();
  return s.mode === "live" ? s.currentLiveEdge() : s.t;
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
  const [stats, setStats] = useState("");
  const [webglError, setWebglError] = useState<string | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  const [sheetOpen, setSheetOpen] = useState(false);
  const selection = useWorld((s) => s.selection);
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      return localStorage.getItem("strata.ops.panel") !== "closed";
    } catch {
      return true;
    }
  });
  const showStats =
    typeof location !== "undefined" && location.search.includes("debug");

  // Engine lifecycle.
  useEffect(() => {
    if (!facility || !hostRef.current || !labelRef.current) return;
    let engine: WorldEngine;
    let withIntro = false;
    try {
      withIntro = sessionStorage.getItem("strata.intro") !== "done";
    } catch {
      withIntro = false;
    }
    try {
      engine = new WorldEngine(
        hostRef.current,
        labelRef.current,
        facility,
        patches,
        withIntro,
      );
    } catch (e) {
      setWebglError(e instanceof Error ? e.message : "WebGL unavailable");
      return;
    }
    engineRef.current = engine;
    const placeImagery = (img: {
      url: string;
      bounds: { west: number; south: number; east: number; north: number };
    }) => {
      const fr = new EnuFrame(facility.origin);
      const sw = fr.toEnu({
        lat: img.bounds.south,
        lon: img.bounds.west,
        alt: 0,
      });
      const ne = fr.toEnu({
        lat: img.bounds.north,
        lon: img.bounds.east,
        alt: 0,
      });
      engine.setOrthophoto(img.url, { x0: sw.x, y0: sw.y, x1: ne.x, y1: ne.y });
    };
    const { orthophoto: ortho, basemap } = useWorld.getState();
    // A surveyed orthophoto wins; otherwise the site's tile server, if one is configured.
    if (ortho) placeImagery(ortho);
    else if (basemap)
      void buildBasemap(facility.origin, facility.halfExtentM, basemap).then(
        (m) => m && engineRef.current === engine && placeImagery(m),
      );
    engine.setGridFrame(facility.origin);
    const host = hostRef.current;
    const afterIntro = () => {
      try {
        sessionStorage.setItem("strata.intro", "done");
      } catch {
        /* storage unavailable */
      }
      setIntroFade(0);
      engine.flyTo({ x: 0, y: -150, z: 0 }, 3200, 20, -42);
    };
    if (withIntro) {
      host.addEventListener("intro-done", afterIntro, { once: true });
      setIntroFade(0);
    } else {
      setIntroFade(0);
      engine.flyTo({ x: 0, y: -150, z: 0 }, 3200, 20, -42);
    }
    engine.getTime = now;
    engine.getTracks = (t) => {
      if (useTime.getState().mode === "live") return tracks.liveAt(t);
      tracks.ensure(t);
      return tracks.replayAt(t);
    };
    engine.onPick = (s) => {
      useWorld.getState().select(s);
      if (s?.kind === "track") {
        const p = engine.trackPosition(s.id);
        if (p) engine.flyTo({ x: p.x, y: p.y, z: p.z }, 180);
      }
    };
    engine.onHover = (s) => useWorld.getState().setHover(s);
    engine.extraLabels = () => {
      const out = [];
      const cam = engine.camera.position;
      for (const b of facility.buildings) {
        const p = new THREE.Vector3(
          b.center.x,
          b.center.y,
          terrainHeight(b.center.x, b.center.y) + b.height + 4,
        );
        const d = p.distanceTo(cam);
        if (d > 1300 || b.kind === "shelter" || b.kind === "gatehouse")
          continue;
        out.push({
          id: `b:${b.id}`,
          position: p,
          text: `${b.label} · ${b.name}`,
          tone: "building" as const,
          priority: 4,
        });
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
      if (s.fly && s.fly !== prev.fly)
        engine.flyTo(
          s.fly.position,
          s.fly.distance,
          s.fly.headingDeg,
          s.fly.pitchDeg,
        );
      if (s.viewThrough !== prev.viewThrough)
        engine.viewThrough(
          s.viewThrough
            ? (getCameras().find((c) => c.id === s.viewThrough) ?? null)
            : null,
        );
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
      setStats(
        `${st.fps} fps · ${st.frameMs} ms · ${st.drawCalls} draws · ${(st.triangles / 1000).toFixed(0)}k tris · ${st.tracks} tracks`,
      );
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(statsId);
      unsub();
      engine.dispose();
      engineRef.current = null;
    };
  }, [facility, patches, narrow]);

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
      if (m.type !== "observations") return;
      for (const o of m.observations)
        if (o.kind === "rf" && o.position)
          rfLive.push({ x: o.position.x, y: o.position.y, r: 250, at: o.t });
      while (rfLive.length > 200) rfLive.shift();
    });
    const sync = async () => {
      const engine = engineRef.current;
      if (!engine) return;
      const t = now();
      const time = useTime.getState();
      const w = useWorld.getState();
      const d = useData.getState();
      const isLive = time.mode === "live";
      // Replay state (structures, objects, sensor status, infrastructure) at t.
      if (
        !busyReplay &&
        ((isLive && Date.now() - lastReplayAt > 5000) ||
          (!isLive && Math.abs(t - lastReplayT) > 1500))
      ) {
        busyReplay = true;
        lastReplayT = t;
        lastReplayAt = Date.now();
        d.loadReplayState(t)
          .then(() => {
            const r = useData.getState().replay;
            if (!r || !engineRef.current) return;
            engineRef.current.setStructures(r.structures);
            engineRef.current.setObjects(r.objects);
            engineRef.current.setInfrastructure(
              isLive
                ? { ...r.infrastructure, ...useData.getState().infra }
                : r.infrastructure,
            );
            const status: Record<string, string> = {};
            for (const [k, v] of Object.entries(r.sensors))
              status[k] = v.status;
            if (isLive)
              for (const [k, v] of Object.entries(useData.getState().sensors))
                status[k] = v.status;
            engineRef.current.setSensorStatus(status);
          })
          .catch(() => undefined)
          .finally(() => (busyReplay = false));
      }
      // Coverage / uncertainty.
      const wantCov =
        w.layers.uncertainty || w.mode === "COVERAGE" || w.mode === "EVIDENCE";
      if (
        wantCov &&
        !busyCov &&
        (Math.abs(t - lastCovT) > (isLive ? 30_000 : 4000) ||
          Date.now() - lastCovAt > 30_000)
      ) {
        busyCov = true;
        lastCovT = t;
        lastCovAt = Date.now();
        d.loadCoverage(t)
          .catch(() => undefined)
          .finally(() => (busyCov = false));
      }
      engine.setPatchMode(
        w.mode === "EVIDENCE" ? "state" : wantCov ? "support" : "off",
        useData.getState().coverage,
      );
      engine.setAlerts(d.alerts, t);
      const changes =
        w.mode === "DIFF" && w.diff
          ? d.changes.filter(
              (c) =>
                c.t > Math.min(w.diff!.a, w.diff!.b) &&
                c.t <= Math.max(w.diff!.a, w.diff!.b),
            )
          : d.changes.filter((c) => c.t <= t && c.t > t - 3 * 3600_000);
      engine.setChanges(
        changes,
        w.selection?.kind === "change" ? new Set([w.selection.id]) : null,
      );
      engine.setIncidents(d.incidents, w.incidentId, null);
      const ops = useOps.getState();
      engine.setThreat(
        w.layers.zones ? ops.vitalAssets : [],
        isLive && w.layers.zones ? ops.threats : [],
      );
      // RF evidence regions.
      if (w.layers.rf) {
        if (isLive)
          engine.setRf(
            rfLive.map((g) => ({ x: g.x, y: g.y, r: g.r, age: t - g.at })),
          );
        else if (Date.now() - lastRfAt > 1500) {
          lastRfAt = Date.now();
          get<{ x: number; y: number; r: number; t: number }[]>(
            `/api/replay/observations?${qs({ kind: "rf", from: Math.round(t - 12_000), to: Math.round(t) })}`,
          )
            .then((rows) =>
              engineRef.current?.setRf(
                rows.map((r) => ({ x: r.x, y: r.y, r: r.r, age: t - r.t })),
              ),
            )
            .catch(() => undefined);
        }
      }
      // Projected camera feed.
      const sel = w.selection;
      if (w.projectFeed && sel?.kind === "sensor") {
        const cam = getCameras().find((c) => c.id === sel.id);
        engine.setFeedProjection(
          cam ?? null,
          cam
            ? `/api/media/frame?${qs({ sensorId: cam.id, t: Math.floor(t / 2000) * 2000 })}`
            : null,
        );
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
      void useData
        .getState()
        .loadChanges(
          t.rangeFrom || t.currentLiveEdge() - 3 * 3600_000,
          t.currentLiveEdge() + 60_000,
        )
        .catch(() => undefined);
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      const time = useTime.getState();
      if (e.key === " ") {
        e.preventDefault();
        time.togglePlay();
      } else if (e.key === "ArrowLeft") time.step(e.shiftKey ? -10 : -1);
      else if (e.key === "ArrowRight") time.step(e.shiftKey ? 10 : 1);
      else if (e.key === "Escape") {
        const w = useWorld.getState();
        if (w.viewThrough) w.setViewThrough(null);
        else w.select(null);
      } else if (e.key.toLowerCase() === "l" && !e.ctrlKey) time.goLive();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  // Modes that imply time behaviour.
  useEffect(() => {
    if (mode === "NOW") useTime.getState().goLive();
  }, [mode]);

  const tmode = useTime((s) => s.mode);
  const banner =
    mode === "INCIDENT" && incidentId ? (
      <span>
        <StateChip state="RECONSTRUCTED" label="incident reconstruction" />{" "}
        replaying recorded evidence
      </span>
    ) : mode === "DIFF" ? (
      <span>
        REALITY DIFF · world shows <b>{diffShow}</b>
      </span>
    ) : mode === "COVERAGE" ? (
      <span>COVERAGE · observation support · hatched = never observed</span>
    ) : mode === "EVIDENCE" ? (
      <span>EVIDENCE · select any surface for its ledger</span>
    ) : tmode === "replay" ? (
      <span>
        HISTORY · recorded state at{" "}
        <span className="mono">{hms(useTime.getState().t)}Z</span>
      </span>
    ) : null;

  // The divider owns collapsing (Enter on the separator hides or restores the inspector), so the dock drives it.
  const togglePanel = () =>
    splitRef.current
      ?.querySelector(':scope > * > [role="separator"][aria-valuenow]')
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
  const onLayout = (sizes: number[]) => {
    const open = (sizes[1] ?? 0) > 0.5;
    setPanelOpen(open);
    try {
      localStorage.setItem("strata.ops.panel", open ? "open" : "closed");
    } catch {
      /* session only */
    }
  };
  const fit = () => {
    if (facility)
      useWorld
        .getState()
        .flyTo({ x: 0, y: 0, z: 0 }, facility.halfExtentM * 2.1);
  };

  const world = (
    <>
      <section className="ops-world" aria-label="4D world">
        {webglError ? (
      <div className="err">
        3D world unavailable: {webglError}. All other areas remain usable.
      </div>
        ) : (
      <>
        <div ref={hostRef} className="world-canvas" />
        <div ref={labelRef} className="world-labels" />
        <div className="intro-fade" style={{ opacity: introFade }} />
        {facility && (
          <MapHud
            engineRef={engineRef}
            hostRef={hostRef}
            facility={facility}
          />
        )}
      </>
        )}
        <ModeControl />
        <ToolDock
      panelOpen={narrow ? sheetOpen : panelOpen}
      onTogglePanel={narrow ? () => setSheetOpen((o) => !o) : togglePanel}
      onFit={fit}
        />
        {banner && <div className="mode-banner glass">{banner}</div>}
        {viewThrough && (
      <div className="world-hud glass" style={{ padding: "6px 10px" }}>
        Viewing reconstructed world from{" "}
        <b className="mono">{viewThrough}</b> calibrated pose
        <button
          className="btn small"
          onClick={() => useWorld.getState().setViewThrough(null)}
        >
          Exit (Esc)
        </button>
      </div>
        )}
        {showStats && (
      <div className="perf" aria-hidden>
        {stats}
      </div>
        )}
        <GetStarted />
        <ErrorBoundary area="Copilot">
      <Copilot />
        </ErrorBoundary>
      </section>
      <section className="ops-bottom" aria-label="Timeline">
        <Timeline />
      </section>
    </>
  );

  if (narrow)
    return (
      <div className="ops narrow">
        <div className="ops-col">{world}</div>
        <BottomSheet
          open={selection !== null || sheetOpen}
          onOpenChange={(o) => {
            if (o) return;
            setSheetOpen(false);
            useWorld.getState().select(null);
          }}
          title={selection ? "Inspector" : "Operational picture"}
          detents={[0.5, 0.92]}
          className="ops-sheet"
        >
          <ContextPanel />
        </BottomSheet>
      </div>
    );

  return (
    <div className="ops" ref={splitRef}>
      <ResizablePanels
        label="Operational picture"
        className="ops-split"
        onLayoutChange={onLayout}
      >
        <ResizablePanel
          id="ops-world"
          label="Map"
          defaultSize={74}
          minSize={420}
        >
          {world}
        </ResizablePanel>
        <ResizablePanel
          id="ops-context"
          label="Inspector"
          defaultSize={26}
          minSize={320}
          maxSize={560}
          collapsible
          defaultCollapsed={!panelOpen}
        >
          <ContextPanel />
        </ResizablePanel>
      </ResizablePanels>
    </div>
  );
}

function useNarrow() {
  const q = "(max-width: 760px)";
  const [m, setM] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia(q).matches,
  );
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}
