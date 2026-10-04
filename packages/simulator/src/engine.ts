import { FACILITY, findSensor, type IngestEnvelope } from '@strata/domain';
import { TruthWorld, type ScheduledScenario } from './truth/world.ts';
import {
  cameraStep,
  droneTelemetryStep,
  gpsStep,
  externalStep,
  healthStep,
  infrastructureStep,
  lidarStep,
  radarStep,
  rfStep,
  satelliteStep,
  type MediaUpload,
  type StepOutput,
} from './sensors/models.ts';
import { renderOrtho } from './render/ortho.ts';

export interface EngineStats {
  steps: number;
  messages: number;
  media: number;
  delayedPending: number;
  lastStepMs: number;
}

/**
 * Advances the synthetic world one second at a time and runs every sensor model. Output is the exact
 * wire traffic real adapters would produce. Messages from network segments under partition are held and
 * released later (with their original observation times) to reproduce late, out-of-order delivery.
 */
export class SimulatorEngine {
  readonly world: TruthWorld;
  private pending: { release: number; msg: IngestEnvelope }[] = [];
  contradiction: { entityId: string; dx: number; dy: number; until: number } | null = null;
  readonly stats: EngineStats = { steps: 0, messages: 0, media: 0, delayedPending: 0, lastStepMs: 0 };

  constructor(schedule: ScheduledScenario[]) {
    this.world = new TruthWorld(schedule);
  }

  step(t: number): StepOutput {
    const t0 = performance.now();
    const entities = this.world.entitiesAt(t);
    const contradict = this.contradiction && t < this.contradiction.until ? this.contradiction : null;
    const lidar = lidarStep(this.world, t);
    const sat = satelliteStep(this.world, t, (w, at, gsd, half) => renderOrtho(w, at, gsd, half));
    const produced: IngestEnvelope[] = [
      ...healthStep(this.world, t),
      ...radarStep(this.world, t, entities),
      ...rfStep(this.world, t, entities),
      ...cameraStep(this.world, t, entities),
      ...gpsStep(this.world, t, entities, contradict),
      ...droneTelemetryStep(this.world, t),
      ...externalStep(this.world, t, entities),
      ...infrastructureStep(this.world, t, entities),
      ...lidar.messages,
      ...sat.messages,
    ];
    const messages: IngestEnvelope[] = [];
    for (const m of produced) {
      const seg = findSensor(m.sensorId, FACILITY)?.segment;
      const release = seg ? this.world.releaseTime(seg, t) : null;
      if (release !== null) this.pending.push({ release, msg: m });
      else messages.push(m);
    }
    const ready = this.pending.filter((p) => p.release <= t);
    if (ready.length) {
      this.pending = this.pending.filter((p) => p.release > t);
      for (const r of ready) messages.push({ ...r.msg, sentAt: t });
    }
    const media: MediaUpload[] = [...lidar.media, ...sat.media];
    this.stats.steps++;
    this.stats.messages += messages.length;
    this.stats.media += media.length;
    this.stats.delayedPending = this.pending.length;
    this.stats.lastStepMs = performance.now() - t0;
    return { messages, media };
  }
}
