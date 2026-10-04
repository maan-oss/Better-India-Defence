import * as THREE from 'three';
import { boxFootprint, buildingBoxes, terrainHeight, type FacilityDef, type RoadDef } from '@strata/domain';
import type { DsmGeometry, StructureState, WorldObjectState } from '../api/types';

const SURFACE_COLORS: Record<RoadDef['surface'], string> = {
  runway: '#1d1f22',
  taxiway: '#202326',
  apron: '#24272a',
  asphalt: '#1a1c1e',
  gravel: '#1f1e1b',
};

/** Roads and airfield surfaces as draped ribbons (single merged mesh, vertex colours). */
export function buildRoads(f: FacilityDef): THREE.Group {
  const g = new THREE.Group();
  const positions: number[] = [];
  const colors: number[] = [];
  const marks: number[] = [];
  const col = new THREE.Color();
  for (const r of f.roads) {
    col.set(SURFACE_COLORS[r.surface]);
    const n = r.closed ? r.points.length : r.points.length - 1;
    for (let i = 0; i < n; i++) {
      const a = r.points[i]!;
      const b = r.points[(i + 1) % r.points.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const nx = -uy * (r.width / 2);
      const ny = ux * (r.width / 2);
      const steps = Math.max(1, Math.ceil(len / 40));
      const lift = r.surface === 'runway' ? 0.12 : r.surface === 'apron' ? 0.1 : 0.14;
      for (let s = 0; s < steps; s++) {
        const p0 = { x: a.x + (b.x - a.x) * (s / steps), y: a.y + (b.y - a.y) * (s / steps) };
        const p1 = { x: a.x + (b.x - a.x) * ((s + 1) / steps), y: a.y + (b.y - a.y) * ((s + 1) / steps) };
        const q = [
          [p0.x + nx, p0.y + ny],
          [p0.x - nx, p0.y - ny],
          [p1.x - nx, p1.y - ny],
          [p1.x + nx, p1.y + ny],
        ] as const;
        const z = q.map(([x, y]) => terrainHeight(x, y) + lift);
        for (const idx of [0, 1, 2, 0, 2, 3]) {
          positions.push(q[idx]![0], q[idx]![1], z[idx]!);
          colors.push(col.r, col.g, col.b);
        }
      }
      if (r.surface === 'runway' || r.surface === 'taxiway') {
        for (let s = 0; s < len; s += r.surface === 'runway' ? 60 : 30) {
          const e = Math.min(len, s + (r.surface === 'runway' ? 30 : 15));
          marks.push(a.x + ux * s, a.y + uy * s, 0.3, a.x + ux * e, a.y + uy * e, 0.3);
        }
      }
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.computeVertexNormals();
  g.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.Float32BufferAttribute(marks, 3));
  g.add(new THREE.LineSegments(mg, new THREE.LineBasicMaterial({ color: '#8d877d', transparent: true, opacity: 0.55 })));
  return g;
}

export function buildZones(f: FacilityDef): THREE.Group {
  const g = new THREE.Group();
  for (const z of f.zones) {
    if (z.kind === 'perimeter') continue;
    const pts = z.polygon.map((p) => new THREE.Vector3(p.x, p.y, terrainHeight(p.x, p.y) + 0.6));
    const color = z.restricted ? '#d9a441' : '#8fa3ad';
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color, dashSize: 8, gapSize: 5, transparent: true, opacity: 0.7 }));
    line.computeLineDistances();
    g.add(line);
    const shape = new THREE.Shape(z.polygon.map((p) => new THREE.Vector2(p.x, p.y)));
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.035, depthWrite: false }));
    fill.position.z = 0.4;
    g.add(fill);
  }
  return g;
}

export function buildFence(f: FacilityDef): { group: THREE.Group; segments: Map<string, THREE.Line> } {
  const g = new THREE.Group();
  const segments = new Map<string, THREE.Line>();
  for (const s of f.fence) {
    const n = 20;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const x = s.a.x + ((s.b.x - s.a.x) * i) / n;
      const y = s.a.y + ((s.b.y - s.a.y) * i) / n;
      pts.push(new THREE.Vector3(x, y, terrainHeight(x, y) + 2.4));
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#6f6a62', transparent: true, opacity: 0.8 }));
    line.userData = { pick: 'fence', id: s.id };
    segments.set(s.id, line);
    g.add(line);
  }
  return { group: g, segments };
}

const bodyMat = new THREE.MeshStandardMaterial({ color: '#2a2d31', roughness: 0.92, metalness: 0.04 });
const reconMat = new THREE.MeshStandardMaterial({ color: '#25302e', roughness: 0.9, metalness: 0.02 });
const edgeMat = new THREE.LineBasicMaterial({ color: '#ece6dc', transparent: true, opacity: 0.2 });
const reconEdgeMat = new THREE.LineBasicMaterial({ color: '#7fb3aa', transparent: true, opacity: 0.5 });
const ghostMat = new THREE.LineDashedMaterial({ color: '#807b72', dashSize: 2, gapSize: 2, transparent: true, opacity: 0.55 });

function decodeDsm(g: DsmGeometry): Float32Array {
  const bin = atob(g.heights);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Float32Array(buf.buffer);
}

/**
 * Buildings from world memory structure versions. PRIOR geometry (design data) renders as solid massing;
 * LiDAR-reconstructed (DSM) geometry renders cell by cell — unknown cells are left empty — with the
 * superseded prior shown only as a dashed ghost outline.
 */
export function buildBuildings(f: FacilityDef, structures: StructureState[] | null): THREE.Group {
  const g = new THREE.Group();
  for (const b of f.buildings) {
    const st = structures?.find((s) => s.buildingId === b.id);
    const bg = new THREE.Group();
    bg.userData = { pick: 'building', id: b.id };
    if (st?.geometry && st.geometry.type === 'dsm') {
      const d = st.geometry;
      const h = decodeDsm(d);
      const cells: THREE.Matrix4[] = [];
      for (let r = 0; r < d.rows; r++)
        for (let c = 0; c < d.cols; c++) {
          const v = h[r * d.cols + c]!;
          if (!Number.isFinite(v) || v - d.baseZ < 0.3) continue;
          const height = v - d.baseZ;
          const m = new THREE.Matrix4().compose(new THREE.Vector3(d.x0 + (c + 0.5) * d.cellM, d.y0 + (r + 0.5) * d.cellM, d.baseZ + height / 2), new THREE.Quaternion(), new THREE.Vector3(d.cellM * 0.98, d.cellM * 0.98, height));
          cells.push(m);
        }
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), reconMat, cells.length);
      cells.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.userData = { pick: 'building', id: b.id };
      bg.add(inst);
      // Ghost of superseded prior geometry.
      for (const box of buildingBoxes(b)) {
        const geo = new THREE.BoxGeometry(box.width, box.depth, box.height);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), ghostMat);
        edges.position.set(box.center.x, box.center.y, box.z0 + box.height / 2);
        edges.rotation.z = (box.yawDeg * Math.PI) / 180;
        edges.computeLineDistances();
        bg.add(edges);
      }
      bg.userData.state = 'RECONSTRUCTED';
    } else {
      const parts = st?.geometry && st.geometry.type === 'box' ? st.geometry.parts.map((p, i) => ({ id: `${b.id}#${i}`, ...p })) : undefined;
      for (const box of buildingBoxes(b, parts)) {
        const geo = new THREE.BoxGeometry(box.width, box.depth, box.height);
        const mesh = new THREE.Mesh(geo, bodyMat);
        mesh.position.set(box.center.x, box.center.y, box.z0 + box.height / 2);
        mesh.rotation.z = (box.yawDeg * Math.PI) / 180;
        mesh.userData = { pick: 'building', id: b.id };
        bg.add(mesh);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), st?.state === 'RECONSTRUCTED' ? reconEdgeMat : edgeMat);
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        bg.add(edges);
      }
      bg.userData.state = st?.state ?? 'PRIOR';
    }
    g.add(bg);
  }
  return g;
}

const OBJ_COLORS: Record<string, string> = { expected: '#3a3c3f', confirmed: '#4a4d50', detected: '#d9a441', missing: '#d4553f' };

export function buildObjects(objects: WorldObjectState[]): THREE.Group {
  const g = new THREE.Group();
  for (const o of objects) {
    const w = Math.max(1, o.extentM * 2);
    const h = o.kind === 'light_mast' ? 20 : o.kind === 'container' ? 2.6 : o.kind === 'barrier' ? 1.1 : 2;
    const geo = new THREE.BoxGeometry(o.kind === 'container' ? 12.2 : w * 0.8, o.kind === 'container' ? 2.5 : w * 0.8, h);
    const z = terrainHeight(o.position.x, o.position.y) + h / 2;
    if (o.state === 'missing') {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineDashedMaterial({ color: OBJ_COLORS.missing, dashSize: 0.6, gapSize: 0.6 }));
      edges.position.set(o.position.x, o.position.y, z);
      edges.rotation.z = (o.yawDeg * Math.PI) / 180;
      edges.computeLineDistances();
      edges.userData = { pick: 'object', id: o.id };
      g.add(edges);
      continue;
    }
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: OBJ_COLORS[o.state] ?? '#3a3c3f', roughness: 0.9 }));
    mesh.position.set(o.position.x, o.position.y, z);
    mesh.rotation.z = (o.yawDeg * Math.PI) / 180;
    mesh.userData = { pick: 'object', id: o.id };
    g.add(mesh);
  }
  return g;
}

export function footprintCenter(id: string, f: FacilityDef): THREE.Vector3 | null {
  const b = f.buildings.find((x) => x.id === id);
  if (!b) return null;
  const fp = boxFootprint(b);
  return new THREE.Vector3(fp.reduce((s, p) => s + p.x, 0) / 4, fp.reduce((s, p) => s + p.y, 0) / 4, terrainHeight(b.center.x, b.center.y) + b.height);
}
