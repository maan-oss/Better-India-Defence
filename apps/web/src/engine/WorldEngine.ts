import * as THREE from 'three';
import { directionFromHeadingPitch, EnuFrame, terrainHeight, toUtm, type AlertRecord, type CameraDef, type FacilityDef, type IncidentRecord, type SurfacePatch, type Vec3 } from '@strata/domain';
import { CameraController, type NavMode } from './controls';
import { createTerrain } from './terrain';
import { buildBuildings, buildFence, buildObjects, buildRoads, buildZones } from './staticWorld';
import { SensorsLayer } from './sensorsLayer';
import { TracksLayer } from './tracksLayer';
import { Overlays } from './overlays';
import { PatchesLayer, writeGroundCoverage } from './patchesLayer';
import { LabelLayer, type LabelSpec } from './labels';
import { GlobeIntro } from './intro';
import type { RenderTrack } from '../state/tracks';
import type { Coverage, StructureState, WorldChangeRow, WorldObjectState } from '../api/types';
import type { LayerKey, Selection } from '../state/world';
import { hms } from '../lib/format';
import { P } from '../lib/palette';

export interface EngineStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  tracks: number;
}

/**
 * The world renderer. Owns the Three.js scene and is driven imperatively by the Operations view: React
 * pushes state in (structures, coverage, layers, selection), and the engine pulls time-varying data
 * (tracks at t) every frame. Rendering is decoupled from React re-renders.
 */
export class WorldEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 1, 20000);
  readonly controls: CameraController;
  private terrain: ReturnType<typeof createTerrain>;
  private roads: THREE.Group;
  private zones: THREE.Group;
  private fence: ReturnType<typeof buildFence>;
  private buildings: THREE.Group;
  private objects = new THREE.Group();
  private sensors: SensorsLayer;
  private tracksLayer = new TracksLayer();
  private overlays = new Overlays();
  private patches: PatchesLayer;
  private labels: LabelLayer;
  private intro: GlobeIntro | null = null;
  private raf = 0;
  private last = performance.now();
  private frameTimes: number[] = [];
  private raycaster = new THREE.Raycaster();
  private layers: Record<LayerKey, boolean> | null = null;
  private selection: Selection | null = null;
  private involvedSensors: Set<string> | null = null;
  private feedCam = new THREE.PerspectiveCamera(30, 16 / 9, 1, 2000);
  private feedTexture: THREE.Texture | null = null;
  private currentTracks: RenderTrack[] = [];
  private structureKey = '';
  stats: EngineStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, tracks: 0 };
  onPick: ((s: Selection | null) => void) | null = null;
  onHover: ((s: Selection | null) => void) | null = null;
  onUserMove: (() => void) | null = null;
  getTime: () => number = () => Date.now();
  getTracks: (t: number) => RenderTrack[] = () => [];
  extraLabels: () => LabelSpec[] = () => [];

  constructor(
    private readonly host: HTMLElement,
    labelRoot: HTMLElement,
    private readonly facility: FacilityDef,
    patchList: SurfacePatch[],
    withIntro: boolean,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(P.bg0);
    this.scene.fog = new THREE.FogExp2(P.bg0, 0.00009);
    this.scene.add(new THREE.HemisphereLight('#c6d3e2', '#141d27', 1.1));
    const sun = new THREE.DirectionalLight('#f2f5f8', 1.5);
    sun.position.set(1400, -1800, 2200);
    this.scene.add(sun);

    this.terrain = createTerrain(facility.halfExtentM);
    this.roads = buildRoads(facility);
    this.zones = buildZones(facility);
    this.fence = buildFence(facility);
    this.buildings = buildBuildings(facility, null);
    this.sensors = new SensorsLayer(facility);
    this.patches = new PatchesLayer(patchList);
    this.scene.add(this.terrain.mesh, this.roads, this.zones, this.fence.group, this.buildings, this.objects, this.sensors.group, this.sensors.frustumGroup, this.sensors.coverageGroup, this.tracksLayer.group, this.overlays.changes, this.overlays.alerts, this.overlays.incidents, this.overlays.rf, this.overlays.threat, this.patches.mesh);
    this.labels = new LabelLayer(labelRoot);
    this.controls = new CameraController(this.camera, this.renderer.domElement);
    this.controls.onUserInput = () => this.onUserMove?.();
    if (withIntro) {
      this.intro = new GlobeIntro(facility.origin.lat, facility.origin.lon);
      this.intro.begin();
      this.controls.distance = 9000;
      this.controls.pitch = -80 * (Math.PI / 180);
    }
    this.bindPointer();
    this.resize();
    window.addEventListener('resize', this.resize);
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.controls.dispose();
    this.labels.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize = () => {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  // ---------------------------------------------------------------------------------- state input

  setLayers(l: Record<LayerKey, boolean>): void {
    this.layers = l;
    this.terrain.mesh.visible = l.terrain;
    this.roads.visible = l.roads;
    this.zones.visible = l.zones;
    this.buildings.visible = l.buildings;
    this.objects.visible = l.objects;
    this.sensors.group.visible = l.sensors;
    this.sensors.frustumGroup.visible = l.frustums;
    this.sensors.coverageGroup.visible = l.coverage;
    this.overlays.changes.visible = l.changes;
    this.overlays.alerts.visible = l.alerts;
    this.overlays.incidents.visible = l.incidents;
    this.overlays.rf.visible = l.rf;
    (this.terrain.material.uniforms.uCoverageOn as { value: number }).value = l.uncertainty ? 1 : 0;
    (this.terrain.material.uniforms.uGridOn as { value: number }).value = l.grid ? 1 : 0;
  }

  /** Align the terrain grid with the site's UTM grid (linear map from site ENU, fitted over ±1 km). */
  setGridFrame(origin: { lat: number; lon: number; alt: number }): void {
    const fr = new EnuFrame(origin);
    const u0 = toUtm(origin.lat, origin.lon);
    const at = (x: number, y: number) => {
      const g = fr.toGeodetic({ x, y, z: 0 });
      return toUtm(g.lat, g.lon, u0.zone);
    };
    const ex = at(1000, 0);
    const ny = at(0, 1000);
    const m = this.terrain.material.uniforms;
    (m.uGridM!.value as THREE.Vector4).set((ex.easting - u0.easting) / 1000, (ny.easting - u0.easting) / 1000, (ex.northing - u0.northing) / 1000, (ny.northing - u0.northing) / 1000);
    (m.uGridO!.value as THREE.Vector2).set(u0.easting % 100000, u0.northing % 100000);
  }

  /** View state for the HUD: compass heading (deg) and ground metres per CSS pixel at the view centre. */
  viewInfo(): { headingDeg: number; mPerPx: number; pitchDeg: number } {
    const h = this.host.clientHeight || 1;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const mPerPx = (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const headingDeg = ((Math.atan2(dir.x, dir.y) * 180) / Math.PI + 360) % 360;
    const pitchDeg = (Math.asin(Math.max(-1, Math.min(1, dir.z))) * 180) / Math.PI;
    return { headingDeg, mPerPx, pitchDeg };
  }

  /** Rotate the view to north-up, keeping the target. */
  northUp(): void {
    this.controls.flyTo(this.controls.target, this.controls.distance, 0, undefined, 700);
  }

  setPatchMode(mode: 'off' | 'support' | 'state', coverage: Coverage | null): void {
    this.patches.mesh.visible = mode !== 'off';
    if (mode !== 'off') this.patches.apply(coverage, mode, this.selection?.kind === 'patch' ? this.selection.id : null);
    writeGroundCoverage(this.terrain.coverageTex, coverage);
  }

  setStructures(structures: StructureState[] | null): void {
    const key = (structures ?? []).map((s) => s.id).join('|');
    if (key === this.structureKey) return;
    this.structureKey = key;
    this.scene.remove(this.buildings);
    this.buildings = buildBuildings(this.facility, structures);
    this.buildings.visible = this.layers?.buildings ?? true;
    this.scene.add(this.buildings);
  }

  setObjects(objects: WorldObjectState[]): void {
    this.scene.remove(this.objects);
    this.objects = buildObjects(objects);
    this.objects.visible = this.layers?.objects ?? true;
    this.scene.add(this.objects);
  }

  setSensorStatus(status: Record<string, string>): void {
    this.sensors.setStatus(status);
  }

  setInfrastructure(infra: Record<string, { state: string; alarm: boolean }>): void {
    for (const [id, line] of this.fence.segments) {
      const st = infra[id];
      (line.material as THREE.LineBasicMaterial).color.set(st?.alarm ? P.critical : P.fence);
    }
  }

  setChanges(rows: WorldChangeRow[], emphasise: Set<string> | null): void {
    this.overlays.setChanges(rows, emphasise);
  }

  setAlerts(alerts: AlertRecord[], t: number): void {
    this.overlays.setAlerts(alerts, t);
  }

  setIncidents(list: IncidentRecord[], focus: string | null, involvedSensors: string[] | null): void {
    this.overlays.setIncidents(list, focus);
    this.involvedSensors = involvedSensors ? new Set(involvedSensors) : null;
  }

  /** Georeferenced orthophoto as the ground texture; rect in site ENU metres (west, south, east, north). */
  setOrthophoto(url: string | null, rect: { x0: number; y0: number; x1: number; y1: number } | null): void {
    const u = this.terrain.material.uniforms;
    if (!url || !rect) {
      u.uOrthoOn!.value = 0;
      return;
    }
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      u.uOrtho!.value = tex;
      u.uOrthoRect!.value = new THREE.Vector4(rect.x0, rect.y0, rect.x1, rect.y1);
      u.uOrthoOn!.value = 1;
    });
  }

  setThreat(...a: Parameters<Overlays['setThreat']>): void {
    this.overlays.setThreat(...a);
  }

  setRf(regions: { x: number; y: number; r: number; age: number }[]): void {
    this.overlays.setRf(regions);
  }

  setSelection(s: Selection | null): void {
    this.selection = s;
  }

  setNav(m: NavMode): void {
    this.controls.setMode(m);
  }

  flyTo(p: Vec3, distance: number, headingDeg?: number, pitchDeg?: number): void {
    this.controls.flyTo({ x: p.x, y: p.y, z: p.z ?? terrainHeight(p.x, p.y) }, distance, headingDeg, pitchDeg);
  }

  viewThrough(cam: CameraDef | null): void {
    if (!cam) {
      this.controls.locked = false;
      this.camera.fov = 42;
      this.controls.setMode('orbit');
      return;
    }
    this.controls.setPose(cam.position, cam.headingDeg, cam.pitchDeg);
    this.controls.locked = true;
    this.camera.fov = (2 * Math.atan(Math.tan((cam.hfovDeg * Math.PI) / 360) / this.camera.aspect) * 180) / Math.PI;
  }

  /** Project a recorded camera frame onto the terrain using the camera's calibrated pose. */
  setFeedProjection(cam: CameraDef | null, url: string | null): void {
    const u = this.terrain.material.uniforms;
    if (!cam || !url) {
      (u.uFeedOn as { value: number }).value = 0;
      return;
    }
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      this.feedTexture?.dispose();
      this.feedTexture = tex;
      const d = directionFromHeadingPitch(cam.headingDeg, cam.pitchDeg);
      this.feedCam.position.set(cam.position.x, cam.position.y, cam.position.z);
      this.feedCam.up.set(0, 0, 1);
      this.feedCam.aspect = cam.widthPx / cam.heightPx;
      this.feedCam.fov = (2 * Math.atan(Math.tan((cam.hfovDeg * Math.PI) / 360) / this.feedCam.aspect) * 180) / Math.PI;
      this.feedCam.lookAt(cam.position.x + d.x, cam.position.y + d.y, cam.position.z + d.z);
      this.feedCam.updateMatrixWorld();
      this.feedCam.updateProjectionMatrix();
      (u.uFeed as { value: THREE.Texture | null }).value = tex;
      (u.uFeedMatrix as { value: THREE.Matrix4 }).value.multiplyMatrices(this.feedCam.projectionMatrix, this.feedCam.matrixWorldInverse);
      (u.uFeedPos as { value: THREE.Vector3 }).value.copy(this.feedCam.position);
      (u.uFeedRange as { value: number }).value = cam.rangeM;
      (u.uFeedOn as { value: number }).value = 1;
    });
  }

  trackPosition(id: string): THREE.Vector3 | null {
    return this.tracksLayer.position(id);
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  // ---------------------------------------------------------------------------------- loop

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (this.intro) {
      const k = this.intro.frame(this.renderer, w / h);
      if (k >= 1) {
        this.intro = null;
        this.host.dispatchEvent(new CustomEvent('intro-done'));
      }
      return;
    }
    const t0 = performance.now();
    this.controls.update(dt);
    const t = this.getTime();
    const l = this.layers;
    const tracks = this.getTracks(t);
    this.currentTracks = tracks;
    const selectedTrack = this.selection?.kind === 'track' ? this.selection.id : null;
    this.tracksLayer.update(
      tracks,
      (tr) => {
        if (!l) return true;
        if (tr.id === selectedTrack) return true;
        if (tr.category === 'aerial') return tr.cooperative ? l.drones : l.radarTracks;
        if (tr.category === 'person') return l.personnel;
        if (tr.category === 'vehicle') return l.vehicles;
        return l.radarTracks;
      },
      this.camera,
      h,
      selectedTrack,
      l?.trails ?? true,
      now,
      t,
    );
    const selSensor = this.selection?.kind === 'sensor' ? this.selection.id : null;
    this.sensors.highlight(selSensor, this.involvedSensors, now);
    this.sensors.glyphScale(this.camera.position);
    this.sensors.animate(now);
    this.overlays.animate(now, this.camera.position);
    this.renderer.render(this.scene, this.camera);
    this.labels.update([...this.trackLabels(tracks, t), ...this.extraLabels()], this.camera, w, h);
    const ms = performance.now() - t0;
    this.frameTimes.push(now);
    while (this.frameTimes.length && now - this.frameTimes[0]! > 1000) this.frameTimes.shift();
    this.stats = { fps: this.frameTimes.length, frameMs: Math.round(ms * 10) / 10, drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, tracks: this.tracksLayer.visibleIds.length };
  };

  private trackLabels(tracks: RenderTrack[], t: number): LabelSpec[] {
    const out: LabelSpec[] = [];
    const selected = this.selection?.kind === 'track' ? this.selection.id : null;
    const visible = new Set(this.tracksLayer.visibleIds);
    for (const tr of tracks) {
      if (!visible.has(tr.id)) continue;
      const important = !tr.cooperative && (tr.category === 'aerial' || tr.category === 'person');
      const pos = new THREE.Vector3(tr.position.x, tr.position.y, (tr.category === 'aerial' ? tr.position.z : terrainHeight(tr.position.x, tr.position.y)) + 3);
      const dist = pos.distanceTo(this.camera.position);
      if (tr.id !== selected && !important && dist > 900) continue;
      if (tr.id !== selected && tr.cooperative && dist > 450) continue;
      const lost = tr.status === 'lost' || tr.status === 'coasting';
      if (lost && tr.id !== selected && t - tr.lastConfirmedAt > 600_000) continue;
      out.push({
        id: `tr:${tr.id}`,
        position: pos,
        text: tr.cooperative ? tr.label : tr.id,
        sub: lost ? `LAST OBSERVED ${hms(tr.lastConfirmedAt)}Z · possible region ${Math.round(tr.sigmaH)} m` : tr.cooperative ? undefined : `${tr.reported && tr.reported.affiliation !== 'unknown' ? `${tr.reported.affiliation.toUpperCase()} (${tr.reported.system}) · ` : ''}${tr.classification === 'unknown' ? tr.category : tr.classification} · ${tr.contributors.join(' ')}`,
        tone: lost ? 'inferred' : tr.cooperative ? 'muted' : (tr.category === 'aerial' && tr.classification !== 'bird') || tr.reported?.affiliation === 'hostile' ? 'red' : 'amber',
        priority: tr.id === selected ? 100 : important && !lost ? 60 : 10,
        dx: 12,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------- picking

  private bindPointer(): void {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
      this.onPick?.(this.pick(e.clientX, e.clientY));
    });
    el.addEventListener('dblclick', (e) => {
      const p = this.groundPoint(e.clientX, e.clientY);
      if (p) this.flyTo(p, Math.max(120, this.controls.distance * 0.5));
    });
    let hoverAt = 0;
    el.addEventListener('pointermove', (e) => {
      if (performance.now() - hoverAt < 80) return;
      hoverAt = performance.now();
      const s = this.pick(e.clientX, e.clientY, true);
      el.style.cursor = s && s.kind !== 'point' ? 'pointer' : 'default';
      this.onHover?.(s && s.kind !== 'point' ? s : null);
    });
  }

  private ndc(x: number, y: number): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  groundPoint(x: number, y: number): Vec3 | null {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const hit = this.raycaster.intersectObject(this.terrain.mesh, false)[0];
    return hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null;
  }

  private pick(x: number, y: number, hoverOnly = false): Selection | null {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    this.raycaster.params.Line = { threshold: 3 };
    const targets: THREE.Object3D[] = [this.tracksLayer.group, this.sensors.group, this.overlays.changes, this.overlays.alerts, this.objects, this.buildings];
    if (this.patches.mesh.visible) targets.unshift(this.patches.mesh);
    if (!hoverOnly) targets.push(this.terrain.mesh);
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.pick) o = o.parent;
      if (!o || !o.visible) continue;
      const kind = o.userData.pick as string;
      const id = o.userData.id as string | undefined;
      if (kind === 'patch' && h.faceIndex !== undefined && h.faceIndex !== null) {
        const p = this.patches.patchAtFace(h.faceIndex);
        if (p) return { kind: 'patch', id: p.id, buildingId: p.ownerId };
      }
      if (kind === 'building' && id) {
        const n = h.face?.normal.clone().transformDirection(h.object.matrixWorld) ?? new THREE.Vector3(0, 0, 1);
        const face = n.z > 0.7 ? 'roof' : Math.abs(n.x) > Math.abs(n.y) ? (n.x > 0 ? 'east' : 'west') : n.y > 0 ? 'north' : 'south';
        let best: SurfacePatch | null = null;
        let bd = Infinity;
        for (const p of this.patches.patches) {
          if (p.ownerId !== id || p.face !== face) continue;
          const d = Math.hypot(p.center.x - h.point.x, p.center.y - h.point.y, p.center.z - h.point.z);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        return best ? { kind: 'patch', id: best.id, buildingId: id } : { kind: 'building', id };
      }
      if (kind === 'terrain') {
        if (hoverOnly) return null;
        const i = Math.floor(h.point.x / 80);
        const j = Math.floor(h.point.y / 80);
        void i;
        void j;
        return { kind: 'point', position: { x: h.point.x, y: h.point.y, z: h.point.z } };
      }
      if (id && (kind === 'track' || kind === 'sensor' || kind === 'change' || kind === 'alert' || kind === 'object' || kind === 'incident')) return { kind, id } as Selection;
    }
    return null;
  }

  get tracksNow(): RenderTrack[] {
    return this.currentTracks;
  }
}
