import {
  BoxIndex,
  FACILITY,
  buildingBoxes,
  staticObjectBox,
  terrainHeight,
  type BuildingPartState,
  type FacilityDef,
  type SolidBox,
  type StaticObjectDef,
} from '@strata/domain';
import { basePopulation, friendlyDrones, type FriendlyDrone, type TruthEntity } from './entities.ts';
import type { MotionState } from './itinerary.ts';
import { buildScenario, type InfraEvent, type ScenarioEffects, type ScenarioKey, type SensorOutage } from './scenarios.ts';

export interface ScheduledScenario {
  id: string;
  key: ScenarioKey;
  t0: number;
  source: 'recording' | 'operator';
}

export interface EntityState {
  entity: TruthEntity;
  state: MotionState;
}

export type WorldObject = StaticObjectDef;

/**
 * Ground truth of the synthetic world as a pure function of time and the scenario schedule.
 * Only sensor models read from here; the platform never sees it.
 */
export class TruthWorld {
  readonly facility: FacilityDef = FACILITY;
  private readonly base: TruthEntity[] = basePopulation();
  private readonly drones: FriendlyDrone[] = friendlyDrones();
  private effects: ScenarioEffects[] = [];
  private readonly indexCache = new Map<string, BoxIndex>();

  constructor(schedule: ScheduledScenario[] = []) {
    for (const s of schedule) this.add(s);
  }

  add(s: ScheduledScenario): void {
    this.effects.push(buildScenario(s.key, s.t0));
    this.effects.sort((a, b) => a.t0 - b.t0);
  }

  get scenarioEffects(): readonly ScenarioEffects[] {
    return this.effects;
  }

  droneState(sensorId: string, t: number): MotionState | null {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      for (const o of this.effects[i]!.droneOverrides) if (o.sensorId === sensorId && t >= o.from && t <= o.to) {
        const s = o.motion(t);
        if (s) return s;
      }
    }
    return this.drones.find((d) => d.sensorId === sensorId)?.baseMotion(t) ?? null;
  }

  friendlyDrones(): FriendlyDrone[] {
    return this.drones;
  }

  /** All entities present (and their states) at t. Hidden entities (indoors) are included with visible=false. */
  entitiesAt(t: number): EntityState[] {
    const out: EntityState[] = [];
    for (const e of this.base) {
      const s = e.motion(t);
      if (s) out.push({ entity: e, state: s });
    }
    for (const d of this.drones) {
      const s = this.droneState(d.sensorId, t);
      if (s) out.push({ entity: d.entity, state: s });
    }
    for (const fx of this.effects) for (const e of fx.entities) {
      const s = e.motion(t);
      if (s) out.push({ entity: e, state: s });
    }
    return out;
  }

  buildingParts(buildingId: string, t: number): BuildingPartState[] | undefined {
    let parts: BuildingPartState[] | undefined;
    for (const fx of this.effects) for (const s of fx.structural) if (s.buildingId === buildingId && t >= s.from) parts = s.parts;
    return parts;
  }

  objectsAt(t: number): WorldObject[] {
    const moved = new Map<string, { center: { x: number; y: number }; yawDeg: number }>();
    for (const fx of this.effects) for (const m of fx.moves) if (t >= m.from) moved.set(m.objectId, { center: m.center, yawDeg: m.yawDeg });
    const out: WorldObject[] = this.facility.staticObjects.map((o) => {
      const m = moved.get(o.id);
      return m ? { ...o, center: m.center, yawDeg: m.yawDeg } : o;
    });
    for (const fx of this.effects) for (const o of fx.objects) if (t >= o.from && t < o.to) out.push(o.def);
    return out;
  }

  outage(sensorId: string, t: number): SensorOutage | null {
    for (const fx of this.effects) for (const o of fx.outages) if (o.sensorId === sensorId && t >= o.from && t < o.to) return o;
    return null;
  }

  outages(): SensorOutage[] {
    return this.effects.flatMap((e) => e.outages);
  }

  /** If messages from this network segment are being held back at time t, returns the release time. */
  releaseTime(segment: string, t: number): number | null {
    for (const fx of this.effects) for (const d of fx.delays) if (d.segment === segment && t >= d.from && t < d.to) return d.to;
    return null;
  }

  infrastructureAt(t: number): InfraEvent[] {
    const out: InfraEvent[] = [];
    for (const fx of this.effects) for (const i of fx.infrastructure) if (t >= i.from && t < i.to) out.push(i);
    return out;
  }

  extraLidarScans(sensorId: string, from: number, to: number): number[] {
    return this.effects.flatMap((e) => e.extraLidarScans.filter((s) => s.sensorId === sensorId && s.at >= from && s.at < to).map((s) => s.at));
  }

  droneLidarWindows(sensorId: string): { from: number; to: number; periodS: number }[] {
    return this.effects.flatMap((e) => e.droneLidar.filter((d) => d.sensorId === sensorId));
  }

  structuralSignature(t: number): string {
    const parts = this.facility.buildings.map((b) => (this.buildingParts(b.id, t) ? `${b.id}:${JSON.stringify(this.buildingParts(b.id, t))}` : '')).join('|');
    const objs = this.objectsAt(t)
      .map((o) => `${o.id}@${o.center.x.toFixed(1)},${o.center.y.toFixed(1)},${o.yawDeg}`)
      .join('|');
    return `${parts}#${objs}`;
  }

  staticBoxes(t: number): SolidBox[] {
    const boxes: SolidBox[] = [];
    for (const b of this.facility.buildings) boxes.push(...buildingBoxes(b, this.buildingParts(b.id, t)));
    for (const o of this.objectsAt(t)) {
      boxes.push(staticObjectBox(o));
    }
    return boxes;
  }

  /** Spatial index over static geometry at t (cached per structural state). */
  staticIndex(t: number): BoxIndex {
    const sig = this.structuralSignature(t);
    let idx = this.indexCache.get(sig);
    if (!idx) {
      idx = new BoxIndex(this.staticBoxes(t));
      if (this.indexCache.size > 16) this.indexCache.clear();
      this.indexCache.set(sig, idx);
    }
    return idx;
  }

  entityBox(e: EntityState): SolidBox {
    const { entity, state } = e;
    const z0 = entity.kind === 'drone' || entity.kind === 'bird' ? state.position.z - entity.size.h / 2 : terrainHeight(state.position.x, state.position.y);
    return {
      id: `ent:${entity.id}`,
      ownerId: entity.id,
      center: { x: state.position.x, y: state.position.y },
      z0,
      width: entity.size.w,
      depth: entity.size.d,
      height: entity.size.h,
      yawDeg: (state.headingRad * 180) / Math.PI,
      material: entity.kind === 'vehicle' ? 'vehicle' : entity.kind === 'person' ? 'person' : 'drone',
    };
  }

  /** Boxes of visible moving entities at t (for occlusion, LiDAR and rendering). */
  entityBoxes(t: number): SolidBox[] {
    return this.entitiesAt(t)
      .filter((e) => e.state.visible && e.entity.kind !== 'bird')
      .map((e) => this.entityBox(e));
  }
}
