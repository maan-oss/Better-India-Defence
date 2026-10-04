import * as THREE from 'three';
import { terrainHeight, type AlertRecord, type IncidentRecord } from '@strata/domain';
import type { WorldChangeRow } from '../api/types';
import { LEVEL_COLOR, P, PRIORITY_COLOR } from '../lib/palette';

const CHANGE_COLORS: Record<string, string> = {
  structure_changed: P.serious,
  road_obstruction: P.serious,
  object_appeared: P.caution,
  object_disappeared: P.serious,
  significant_movement: P.caution,
  surface_changed: P.off,
  sensor_offline: P.critical,
  sensor_restored: P.normal,
  infrastructure_changed: P.critical,
};

/** Changes (pins), alerts (pulsing rings), incidents (radius circles) and RF evidence regions. */
export class Overlays {
  readonly changes = new THREE.Group();
  readonly alerts = new THREE.Group();
  readonly incidents = new THREE.Group();
  readonly rf = new THREE.Group();
  readonly threat = new THREE.Group();
  private lastVa: unknown = null;
  private lastThreats: unknown = null;
  private alertRings: { mesh: THREE.LineLoop; priority: string }[] = [];

  setChanges(rows: WorldChangeRow[], emphasise: Set<string> | null): void {
    clear(this.changes);
    for (const c of rows) {
      if (c.kind === 'sensor_restored') continue;
      const ground = terrainHeight(c.x, c.y);
      const color = CHANGE_COLORS[c.kind] ?? P.off;
      const h = c.kind.startsWith('sensor') ? 18 : 32;
      const strong = emphasise ? emphasise.has(c.id) : true;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(c.x, c.y, ground), new THREE.Vector3(c.x, c.y, ground + h)]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: strong ? 0.8 : 0.25 }));
      const head = new THREE.Mesh(new THREE.OctahedronGeometry(2.2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: strong ? 1 : 0.3 }));
      head.position.set(c.x, c.y, ground + h);
      head.userData = { pick: 'change', id: c.id };
      const extent = new THREE.LineLoop(circle(Math.max(4, c.extent_m)), new THREE.LineDashedMaterial({ color, dashSize: 3, gapSize: 3, transparent: true, opacity: strong ? 0.55 : 0.15 }));
      extent.position.set(c.x, c.y, ground + 0.7);
      extent.computeLineDistances();
      this.changes.add(line, head, extent);
    }
  }

  /** Vital-asset protection rings and lines from HIGH/CRITICAL threats to the asset they threaten. */
  setThreat(vas: { id: string; name: string; priority: number; centre: { x: number; y: number }; radiusM: number }[], threats: { trackId: string; level: string; assetId: string; position: { x: number; y: number; z: number } }[]): void {
    if (vas === this.lastVa && threats === this.lastThreats) return;
    this.lastVa = vas;
    this.lastThreats = threats;
    clear(this.threat);
    for (const v of vas) {
      const g = terrainHeight(v.centre.x, v.centre.y);
      const ring = new THREE.LineLoop(circle(v.radiusM), new THREE.LineDashedMaterial({ color: P.zone, dashSize: v.priority === 1 ? 10 : 6, gapSize: 6, transparent: true, opacity: v.priority === 1 ? 0.6 : 0.32 }));
      ring.position.set(v.centre.x, v.centre.y, g + 1.2);
      ring.computeLineDistances();
      this.threat.add(ring);
    }
    for (const t of threats) {
      if (t.level !== 'CRITICAL' && t.level !== 'HIGH') continue;
      const v = vas.find((x) => x.id === t.assetId);
      if (!v) continue;
      const g = terrainHeight(v.centre.x, v.centre.y);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(t.position.x, t.position.y, Math.max(t.position.z, terrainHeight(t.position.x, t.position.y) + 1)), new THREE.Vector3(v.centre.x, v.centre.y, g + 1.2)]),
        new THREE.LineDashedMaterial({ color: LEVEL_COLOR[t.level] ?? P.serious, dashSize: 6, gapSize: 4, transparent: true, opacity: 0.85 }),
      );
      line.computeLineDistances();
      this.threat.add(line);
    }
  }

  setAlerts(alerts: AlertRecord[], t: number): void {
    clear(this.alerts);
    this.alertRings = [];
    for (const a of alerts) {
      if (!a.position || a.t > t || a.status === 'resolved' || a.status === 'dismissed') continue;
      if (t - a.t > 2 * 3600_000) continue;
      const color = PRIORITY_COLOR[a.priority] ?? P.off;
      const ring = new THREE.LineLoop(circle(1), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
      ring.position.set(a.position.x, a.position.y, terrainHeight(a.position.x, a.position.y) + 1);
      ring.userData = { pick: 'alert', id: a.id };
      this.alerts.add(ring);
      this.alertRings.push({ mesh: ring, priority: a.priority });
    }
  }

  setIncidents(list: IncidentRecord[], focus: string | null): void {
    clear(this.incidents);
    for (const i of list) {
      if (i.status === 'closed' && i.id !== focus) continue;
      const ring = new THREE.LineLoop(circle(i.radiusM), new THREE.LineDashedMaterial({ color: P.serious, dashSize: 14, gapSize: 9, transparent: true, opacity: i.id === focus ? 0.85 : 0.35 }));
      ring.position.set(i.center.x, i.center.y, terrainHeight(i.center.x, i.center.y) + 1.2);
      ring.computeLineDistances();
      ring.userData = { pick: 'incident', id: i.id };
      this.incidents.add(ring);
    }
  }

  setRf(regions: { x: number; y: number; r: number; age: number }[]): void {
    clear(this.rf);
    for (const g of regions) {
      const a = Math.max(0, 1 - g.age / 12_000);
      if (a <= 0) continue;
      const m = new THREE.Mesh(new THREE.CircleGeometry(g.r, 48), new THREE.MeshBasicMaterial({ color: P.inferred, transparent: true, opacity: 0.08 * a, depthWrite: false }));
      m.position.set(g.x, g.y, terrainHeight(g.x, g.y) + 0.8);
      const o = new THREE.LineLoop(circle(g.r), new THREE.LineBasicMaterial({ color: P.inferred, transparent: true, opacity: 0.5 * a }));
      o.position.copy(m.position);
      this.rf.add(m, o);
    }
  }

  animate(now: number, cameraPos: THREE.Vector3): void {
    for (const { mesh, priority } of this.alertRings) {
      const period = priority === 'critical' ? 1100 : 1800;
      const k = (now % period) / period;
      const d = cameraPos.distanceTo(mesh.position);
      const base = Math.max(14, d / 40);
      mesh.scale.setScalar(base * (0.6 + k * 1.2));
      (mesh.material as THREE.LineBasicMaterial).opacity = 0.95 * (1 - k);
    }
  }
}

function circle(r: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 96; i++) pts.push(new THREE.Vector3(r * Math.cos((i / 96) * Math.PI * 2), r * Math.sin((i / 96) * Math.PI * 2), 0));
  return new THREE.BufferGeometry().setFromPoints(pts);
}

function clear(g: THREE.Group): void {
  for (const c of [...g.children]) {
    g.remove(c);
    const m = c as THREE.Mesh;
    m.geometry?.dispose();
    (m.material as THREE.Material | undefined)?.dispose?.();
  }
}
