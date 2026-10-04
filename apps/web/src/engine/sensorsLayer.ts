import * as THREE from 'three';
import { directionFromHeadingPitch, frustumFootprint, terrainHeight, type CameraDef, type FacilityDef, type SensorDef } from '@strata/domain';
import { P } from '../lib/palette';

const STATUS_COLOR: Record<string, string> = { ok: P.text2, degraded: P.caution, silent: P.serious, offline: P.critical, fault: P.critical };

interface Frustum {
  group: THREE.Group;
  lines: THREE.LineSegments;
  fill: THREE.Mesh;
  cam: CameraDef;
}

/** Physical sensor installations (masts, glyphs) and calibrated camera frustums with ground footprints. */
export class SensorsLayer {
  readonly group = new THREE.Group();
  readonly frustumGroup = new THREE.Group();
  readonly coverageGroup = new THREE.Group();
  private glyphs = new Map<string, THREE.Mesh>();
  private frustums = new Map<string, Frustum>();
  private radarSweeps: THREE.Mesh[] = [];

  constructor(f: FacilityDef) {
    for (const s of f.sensors) this.addGlyph(s);
    for (const s of f.sensors) if (s.kind === 'camera') this.addFrustum(s);
    for (const s of f.sensors) {
      if (s.kind === 'radar' || s.kind === 'rf' || s.kind === 'lidar') {
        const r = s.kind === 'radar' ? Math.min(s.rangeM, 3600) : s.rangeM;
        const ring = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(Array.from({ length: 128 }, (_, i) => new THREE.Vector3(s.position.x + r * Math.cos((i / 128) * Math.PI * 2), s.position.y + r * Math.sin((i / 128) * Math.PI * 2), 1))),
          new THREE.LineDashedMaterial({ color: s.kind === 'lidar' ? P.reconstructed : P.text2, dashSize: 20, gapSize: 14, transparent: true, opacity: 0.35 }),
        );
        ring.computeLineDistances();
        this.coverageGroup.add(ring);
      }
    }
  }

  private addGlyph(s: SensorDef): void {
    if (!('position' in s)) return;
    const p = s.position;
    const ground = terrainHeight(p.x, p.y);
    let geo: THREE.BufferGeometry;
    if (s.kind === 'camera') geo = new THREE.ConeGeometry(1.1, 2.4, 4);
    else if (s.kind === 'radar') geo = new THREE.CylinderGeometry(1.6, 1.6, 1.4, 16);
    else if (s.kind === 'rf') geo = new THREE.OctahedronGeometry(1.4);
    else geo = new THREE.CylinderGeometry(0.9, 0.9, 1.2, 12);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: STATUS_COLOR.ok }));
    mesh.position.set(p.x, p.y, p.z);
    if (s.kind === 'camera') {
      // Cone apex (+Y) points along the optical axis.
      const d = directionFromHeadingPitch(s.headingDeg, s.pitchDeg);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(d.x, d.y, d.z));
    } else mesh.rotation.x = Math.PI / 2;
    mesh.userData = { pick: 'sensor', id: s.id };
    const mast = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.x, p.y, ground), new THREE.Vector3(p.x, p.y, p.z)]), new THREE.LineBasicMaterial({ color: P.text3 }));
    this.group.add(mast, mesh);
    this.glyphs.set(s.id, mesh);
    if (s.kind === 'radar') {
      const sweep = new THREE.Mesh(new THREE.BoxGeometry(5, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: P.text1 }));
      sweep.position.set(p.x, p.y, p.z + 1);
      this.radarSweeps.push(sweep);
      this.group.add(sweep);
    }
  }

  private addFrustum(cam: CameraDef): void {
    const fp = frustumFootprint(cam, cam.rangeM, 6);
    const o = new THREE.Vector3(cam.position.x, cam.position.y, cam.position.z);
    const corners = [fp[0]!, fp[6]!, fp[12]!, fp[18]!];
    const seg: number[] = [];
    for (const c of corners) seg.push(o.x, o.y, o.z, c.x, c.y, c.z + 0.3);
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i]!;
      const b = fp[(i + 1) % fp.length]!;
      seg.push(a.x, a.y, a.z + 0.3, b.x, b.y, b.z + 0.3);
    }
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(seg, 3)), new THREE.LineBasicMaterial({ color: P.text1, transparent: true, opacity: 0.3 }));
    const shape = new THREE.Shape(fp.map((p) => new THREE.Vector2(p.x, p.y)));
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: P.text0, transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide }));
    fill.position.z = terrainHeight(cam.position.x, cam.position.y) + 0.5;
    const group = new THREE.Group();
    group.add(lines, fill);
    this.frustumGroup.add(group);
    this.frustums.set(cam.id, { group, lines, fill, cam });
  }

  setStatus(status: Record<string, string>): void {
    for (const [id, m] of this.glyphs) (m.material as THREE.MeshBasicMaterial).color.set(STATUS_COLOR[status[id] ?? 'ok'] ?? STATUS_COLOR.ok!);
    for (const [id, f] of this.frustums) {
      const st = status[id] ?? 'ok';
      const down = st === 'silent' || st === 'offline' || st === 'fault';
      (f.lines.material as THREE.LineBasicMaterial).color.set(down ? P.critical : P.text1);
      (f.fill.material as THREE.MeshBasicMaterial).color.set(down ? P.critical : P.text0);
    }
  }

  /** Emphasise the selected camera (activation) and optionally show only it. */
  highlight(id: string | null, involved: Set<string> | null, t: number): void {
    for (const [fid, f] of this.frustums) {
      const sel = fid === id;
      const inv = involved?.has(fid) ?? false;
      const pulse = sel ? 0.5 + 0.18 * Math.sin(t / 260) : 0;
      (f.lines.material as THREE.LineBasicMaterial).opacity = sel ? 0.9 : inv ? 0.6 : 0.28;
      (f.fill.material as THREE.MeshBasicMaterial).opacity = sel ? 0.08 + pulse * 0.05 : inv ? 0.06 : 0.03;
    }
    for (const [gid, g] of this.glyphs) g.scale.setScalar(gid === id ? 1.8 : involved?.has(gid) ? 1.4 : 1);
  }

  animate(t: number): void {
    for (const s of this.radarSweeps) s.rotation.z = (t / 2000) * Math.PI * 2;
  }

  glyphScale(cameraPos: THREE.Vector3): void {
    for (const g of this.glyphs.values()) {
      const d = g.position.distanceTo(cameraPos);
      const base = g.scale.x > 1.2 ? g.scale.x : 1;
      const k = Math.max(1, d / 350);
      g.scale.setScalar(base * k);
    }
  }
}
