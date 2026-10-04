import * as THREE from 'three';
import { terrainHeight } from '@strata/domain';
import type { RenderTrack } from '../state/tracks';

const COLORS = {
  coop: '#cfc9bd',
  person: '#d9a441',
  vehicle: '#d9a441',
  aerial: '#d4553f',
  bird: '#8d877d',
  unknown: '#b9b3a8',
};

interface TrackObj {
  group: THREE.Group;
  body: THREE.Mesh;
  pick: THREE.Mesh;
  ring: THREE.LineLoop;
  drop: THREE.Line;
  trail: THREE.Line;
  kind: string;
}

const ringGeo = (() => {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 72; i++) pts.push(new THREE.Vector3(Math.cos((i / 72) * Math.PI * 2), Math.sin((i / 72) * Math.PI * 2), 0));
  return new THREE.BufferGeometry().setFromPoints(pts);
})();

function bodyGeometry(category: string): THREE.BufferGeometry {
  if (category === 'aerial') return new THREE.OctahedronGeometry(1.6);
  if (category === 'vehicle') return new THREE.BoxGeometry(4.6, 2.0, 1.7).translate(0, 0, 0.85);
  return new THREE.CylinderGeometry(0.45, 0.45, 1.8, 10).rotateX(Math.PI / 2).translate(0, 0, 0.9);
}

/**
 * Fused tracks. Confirmed tracks are solid; coasting/lost tracks (INFERRED) are hollow, held at their last
 * confirmed position, with a dashed possible-region circle whose radius is the physically reachable area.
 */
export class TracksLayer {
  readonly group = new THREE.Group();
  private objs = new Map<string, TrackObj>();
  visibleIds: string[] = [];

  update(tracks: RenderTrack[], filter: (t: RenderTrack) => boolean, cameraPos: THREE.Vector3, selected: string | null, showTrails: boolean, now: number, t: number = now): void {
    const seen = new Set<string>();
    for (const tr of tracks) {
      if (!filter(tr)) continue;
      seen.add(tr.id);
      let o = this.objs.get(tr.id);
      if (!o || o.kind !== tr.category) {
        if (o) this.remove(tr.id);
        o = this.create(tr);
      }
      const color = tr.cooperative ? COLORS.coop : tr.classification === 'bird' ? COLORS.bird : (COLORS[tr.category as keyof typeof COLORS] ?? COLORS.unknown);
      const mat = o.body.material as THREE.MeshBasicMaterial;
      mat.color.set(color);
      mat.wireframe = tr.inferred;
      mat.opacity = tr.inferred ? 0.6 : 1;
      const ground = terrainHeight(tr.position.x, tr.position.y);
      const z = tr.category === 'aerial' ? tr.position.z : ground;
      o.group.position.set(tr.position.x, tr.position.y, 0);
      o.body.position.set(0, 0, z);
      const d = cameraPos.distanceTo(new THREE.Vector3(tr.position.x, tr.position.y, z));
      const s = Math.max(1, d / (tr.category === 'aerial' ? 160 : 220)) * (tr.id === selected ? 1.5 : 1);
      o.body.scale.setScalar(s);
      o.pick.position.set(0, 0, z);
      o.pick.scale.setScalar(Math.max(4, s * 3));
      // Uncertainty / possible region.
      const r = tr.inferred ? tr.sigmaH : Math.min(tr.sigmaH * 2, 60);
      o.ring.visible = r > 1.5;
      o.ring.scale.set(r, r, 1);
      o.ring.position.set(0, 0, ground + 0.6);
      const rm = o.ring.material as THREE.LineDashedMaterial;
      rm.color.set(tr.inferred ? '#a99bc9' : color);
      // Possible regions of long-lost tracks fade: they remain on record but stop dominating the view.
      const lostAge = tr.inferred ? Math.max(0, (t - tr.lastConfirmedAt) / 1000) : 0;
      rm.opacity = tr.inferred ? (tr.id === selected ? 0.85 : Math.max(0.08, 0.75 * (1 - lostAge / 900))) : 0.35;
      rm.dashSize = Math.max(2, r * 0.08);
      rm.gapSize = Math.max(2, r * 0.06);
      o.ring.computeLineDistances();
      if (tr.inferred) o.ring.rotation.z = now / 9000;
      o.drop.visible = tr.category === 'aerial';
      if (o.drop.visible) {
        const pos = o.drop.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, 0, 0, ground);
        pos.setXYZ(1, 0, 0, z);
        pos.needsUpdate = true;
      }
      o.trail.visible = showTrails && tr.trail.length > 1;
      if (o.trail.visible) {
        const pts = tr.trail.map((p) => new THREE.Vector3(p.x - tr.position.x, p.y - tr.position.y, tr.category === 'aerial' ? p.z : terrainHeight(p.x, p.y) + 0.4));
        o.trail.geometry.dispose();
        o.trail.geometry = new THREE.BufferGeometry().setFromPoints(pts);
        (o.trail.material as THREE.LineBasicMaterial).color.set(color);
      }
    }
    for (const id of [...this.objs.keys()]) if (!seen.has(id)) this.remove(id);
    this.visibleIds = [...seen];
  }

  private create(tr: RenderTrack): TrackObj {
    const group = new THREE.Group();
    const body = new THREE.Mesh(bodyGeometry(tr.category), new THREE.MeshBasicMaterial({ color: COLORS.unknown, transparent: true }));
    const pick = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    pick.userData = { pick: 'track', id: tr.id };
    body.userData = { pick: 'track', id: tr.id };
    const ring = new THREE.LineLoop(ringGeo, new THREE.LineDashedMaterial({ color: '#a99bc9', dashSize: 4, gapSize: 3, transparent: true, opacity: 0.7 }));
    const drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: '#8d877d', transparent: true, opacity: 0.5 }));
    const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#cfc9bd', transparent: true, opacity: 0.45 }));
    group.add(body, pick, ring, drop, trail);
    this.group.add(group);
    const o = { group, body, pick, ring, drop, trail, kind: tr.category };
    this.objs.set(tr.id, o);
    return o;
  }

  private remove(id: string): void {
    const o = this.objs.get(id);
    if (!o) return;
    this.group.remove(o.group);
    o.body.geometry.dispose();
    o.trail.geometry.dispose();
    this.objs.delete(id);
  }

  position(id: string): THREE.Vector3 | null {
    const o = this.objs.get(id);
    return o ? new THREE.Vector3(o.group.position.x, o.group.position.y, o.body.position.z) : null;
  }
}
