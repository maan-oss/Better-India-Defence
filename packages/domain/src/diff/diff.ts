import type { Vec3 } from '../math/vec.ts';
import type { ChangeKind } from '../schemas/model.ts';

/**
 * "Git diff for physical reality": compares two world-state snapshots reconstructed by the platform at
 * times A and B. Snapshots contain only what the platform knew at those times (never simulator truth).
 */
export interface SnapshotObject {
  id: string;
  kind: string;
  label: string;
  position: Vec3;
  extentM: number;
  state: string;
}

export interface WorldSnapshotData {
  t: number;
  objects: SnapshotObject[];
  sensors: Record<string, string>;
  infrastructure: Record<string, { state: string; alarm: boolean }>;
  structures: Record<string, { label: string; position: Vec3; extentM: number; signature: string }>;
}

export interface DiffEntry {
  kind: ChangeKind;
  subjectId: string;
  title: string;
  position: Vec3 | null;
  extentM: number;
  before: string | null;
  after: string | null;
}

export function diffSnapshots(a: WorldSnapshotData, b: WorldSnapshotData, sensorPositions: Record<string, Vec3> = {}): DiffEntry[] {
  const out: DiffEntry[] = [];
  const ao = new Map(a.objects.map((o) => [o.id, o]));
  const bo = new Map(b.objects.map((o) => [o.id, o]));
  for (const [id, o] of bo) {
    const prev = ao.get(id);
    if (!prev) {
      out.push({
        kind: o.kind === 'debris' || o.state === 'obstruction' ? 'road_obstruction' : 'object_appeared',
        subjectId: id,
        title: `${o.label} appeared`,
        position: o.position,
        extentM: o.extentM,
        before: null,
        after: o.state,
      });
    } else {
      const moved = Math.hypot(o.position.x - prev.position.x, o.position.y - prev.position.y);
      if (moved > 2) out.push({ kind: 'significant_movement', subjectId: id, title: `${o.label} moved ${moved.toFixed(1)} m`, position: o.position, extentM: Math.max(o.extentM, moved), before: `${prev.position.x.toFixed(1)}, ${prev.position.y.toFixed(1)}`, after: `${o.position.x.toFixed(1)}, ${o.position.y.toFixed(1)}` });
    }
  }
  for (const [id, o] of ao) if (!bo.has(id)) out.push({ kind: 'object_disappeared', subjectId: id, title: `${o.label} no longer present`, position: o.position, extentM: o.extentM, before: o.state, after: null });
  for (const [id, s] of Object.entries(b.structures)) {
    const prev = a.structures[id];
    if (prev && prev.signature !== s.signature) out.push({ kind: 'structure_changed', subjectId: id, title: `${s.label} geometry changed`, position: s.position, extentM: s.extentM, before: prev.signature, after: s.signature });
  }
  for (const [id, st] of Object.entries(b.sensors)) {
    const prev = a.sensors[id];
    if (prev === undefined || prev === st) continue;
    const down = (v: string) => v === 'offline' || v === 'silent' || v === 'fault';
    if (down(st) && !down(prev)) out.push({ kind: 'sensor_offline', subjectId: id, title: `${id} ${st}`, position: sensorPositions[id] ?? null, extentM: 10, before: prev, after: st });
    else if (!down(st) && down(prev)) out.push({ kind: 'sensor_restored', subjectId: id, title: `${id} restored`, position: sensorPositions[id] ?? null, extentM: 10, before: prev, after: st });
  }
  for (const [id, st] of Object.entries(b.infrastructure)) {
    const prev = a.infrastructure[id];
    if (prev && (prev.state !== st.state || prev.alarm !== st.alarm))
      out.push({ kind: 'infrastructure_changed', subjectId: id, title: `${id}: ${prev.state} → ${st.state}${st.alarm ? ' (ALARM)' : ''}`, position: null, extentM: 20, before: prev.state, after: st.state });
  }
  return out;
}
