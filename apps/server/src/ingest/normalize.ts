import {
  type EnuFrame,
  cameraBasis,
  pixelRay,
  rayTerrain,
  type CameraPose,
  type IngestEnvelope,
  type ObservationQuality,
  type SensorObservation,
  type TrackMeasurement,
  type Vec3,
  terrainHeight,
} from '@strata/domain';

/**
 * Per-kind normalisation from wire envelopes into the platform's event model. Each adapter kind maps to
 * observations (persisted, with provenance) and optional fusion measurements. Positions are converted from
 * WGS84 into the facility ENU frame. Camera detections are geolocated here — a reconstruction step — so
 * their positions are labelled RECONSTRUCTED, not CAPTURED.
 */
export interface StaticDetection {
  observationId: string;
  sensorId: string;
  t: number;
  cls: string;
  position: Vec3;
  sigmaM: number;
  score: number;
  localId: string;
}

export interface CameraFrameRef {
  observationId: string;
  sensorId: string;
  t: number;
  pose: CameraPose;
  frameId: string;
  staticKeyframe: boolean;
  staticDetections: StaticDetection[];
  detectionCount: number;
}

export interface Normalized {
  observations: (SensorObservation & { lat: number | null; lon: number | null })[];
  measurements: TrackMeasurement[];
  frames: CameraFrameRef[];
}

const rad = Math.PI / 180;

export function normalizeEnvelope(env: IngestEnvelope, frame: EnuFrame, receivedAt: number, ingestSeq: number, quality: ObservationQuality, t: number): Normalized {
  const out: Normalized = { observations: [], measurements: [], frames: [] };
  const prov = { adapter: env.adapter, messageId: env.messageId, seq: env.seq, ingestSeq };
  const base = (i: number, kind: SensorObservation['kind']) => ({
    id: `${env.messageId}#${i}`,
    sensorId: env.sensorId,
    kind,
    sourceKind: env.kind,
    t,
    receivedAt,
    quality,
    provenance: prov,
  });

  switch (env.kind) {
    case 'radar.track': {
      env.payload.plots.forEach((p, i) => {
        const pos = frame.toEnu(p.position);
        const sh = Math.hypot(p.sigma.rangeM, p.rangeM * p.sigma.azDeg * rad);
        const sv = Math.hypot(p.sigma.rangeM * Math.sin(p.elevationDeg * rad), p.rangeM * p.sigma.elDeg * rad);
        const vel = { x: p.velocity.ve, y: p.velocity.vn, z: p.velocity.vu };
        const o = { ...base(i, 'track'), position: pos, sigma: { x: sh, y: sh, z: Math.max(3, sv) }, velocity: vel, state: 'CAPTURED' as const, payload: { ...p }, lat: p.position.lat, lon: p.position.lon };
        out.observations.push(o);
        out.measurements.push({
          observationId: o.id,
          sensorId: env.sensorId,
          sensorKind: 'radar',
          localId: p.localTrackId,
          t,
          position: pos,
          sigma: o.sigma,
          velocity: vel,
          cls: 'unknown',
          confidence: p.confidence,
          positional: true,
          attributes: { rcsDbsm: p.rcsDbsm },
        });
      });
      if (!env.payload.plots.length) out.observations.push({ ...base(0, 'track'), position: null, sigma: null, velocity: null, state: 'CAPTURED', payload: { scanId: env.payload.scanId, plots: 0 }, lat: null, lon: null });
      break;
    }
    case 'rf.detection': {
      env.payload.emissions.forEach((e, i) => {
        const c = frame.toEnu(e.region.center);
        const pos = { x: c.x, y: c.y, z: terrainHeight(c.x, c.y) };
        const o = { ...base(i, 'rf'), position: pos, sigma: { x: e.region.radiusM / 2, y: e.region.radiusM / 2, z: 500 }, velocity: null, state: 'CAPTURED' as const, payload: { ...e }, lat: e.region.center.lat, lon: e.region.center.lon };
        out.observations.push(o);
        out.measurements.push({
          observationId: o.id,
          sensorId: env.sensorId,
          sensorKind: 'rf',
          localId: e.emitterId,
          t,
          position: pos,
          sigma: o.sigma,
          cls: 'drone',
          confidence: e.confidence,
          positional: false,
          regionRadiusM: e.region.radiusM,
          attributes: { protocolClass: e.protocolClass, centerFrequencyMHz: e.centerFrequencyMHz },
        });
      });
      break;
    }
    case 'camera.detections': {
      const p = env.payload;
      const pose: CameraPose = { position: frame.toEnu(p.pose.position), headingDeg: p.pose.headingDeg, pitchDeg: p.pose.pitchDeg, hfovDeg: p.pose.hfovDeg, widthPx: p.pose.widthPx, heightPx: p.pose.heightPx };
      const basis = cameraBasis(pose);
      const frameObs = {
        ...base(0, 'media'),
        position: pose.position,
        sigma: null,
        velocity: null,
        state: 'CAPTURED' as const,
        payload: { frameId: p.frameId, pose: p.pose, detections: p.detections.length, classes: p.detections.map((d) => d.cls) },
        lat: p.pose.position.lat,
        lon: p.pose.position.lon,
      };
      out.observations.push(frameObs);
      const ref: CameraFrameRef = { observationId: frameObs.id, sensorId: env.sensorId, t, pose, frameId: p.frameId, staticKeyframe: false, staticDetections: [], detectionCount: p.detections.length };
      // Gimbal cameras on drones are cameras for fusion purposes; the platform's own telemetry is separate.
      const sensorKind = 'camera' as const;
      p.detections.forEach((d, i) => {
        const [bx, by, bw, bh] = d.bbox;
        const footRay = pixelRay(pose, bx + bw / 2, by + bh, basis);
        const ground = d.cls === 'drone' || d.cls === 'bird' ? null : rayTerrain(pose.position, footRay, 3000, 2);
        if (d.isStatic) ref.staticKeyframe = true;
        if (ground) {
          const range = Math.hypot(ground.x - pose.position.x, ground.y - pose.position.y, ground.z - pose.position.z);
          // Error model: ~1.5 px of bbox-foot uncertainty projected to range, plus grazing-angle stretch.
          const grazing = Math.max(0.08, Math.abs(footRay.z));
          const sigmaM = Math.max(0.6, ((1.5 / basis.fx) * range) / grazing);
          const o = {
            ...base(i + 1, 'track'),
            position: ground,
            sigma: { x: sigmaM, y: sigmaM, z: 1 },
            velocity: null,
            state: 'RECONSTRUCTED' as const,
            quality: { ...quality, derivedPosition: true },
            payload: { ...d, frameObservationId: frameObs.id, rangeM: Math.round(range) },
            lat: null,
            lon: null,
          };
          out.observations.push(o);
          if (d.isStatic) {
            ref.staticDetections.push({ observationId: o.id, sensorId: env.sensorId, t, cls: d.cls, position: ground, sigmaM, score: d.score, localId: d.localTrackId });
          } else {
            out.measurements.push({
              observationId: o.id,
              sensorId: env.sensorId,
              sensorKind,
              localId: d.localTrackId,
              t,
              position: ground,
              sigma: o.sigma,
              cls: d.cls,
              confidence: d.score,
              positional: true,
              ...(d.appearance ? { appearance: d.appearance } : {}),
              ...(d.faceQuality !== undefined ? { faceQuality: d.faceQuality } : {}),
              sharpness: d.sharpness,
            });
          }
        } else {
          // Sky / no ground intersection: bearing-only evidence.
          const ray = pixelRay(pose, bx + bw / 2, by + bh / 2, basis);
          const o = {
            ...base(i + 1, 'track'),
            position: null,
            sigma: null,
            velocity: null,
            state: 'CAPTURED' as const,
            payload: { ...d, frameObservationId: frameObs.id, bearing: ray },
            lat: null,
            lon: null,
          };
          out.observations.push(o);
          out.measurements.push({
            observationId: o.id,
            sensorId: env.sensorId,
            sensorKind,
            localId: d.localTrackId,
            t,
            position: pose.position,
            sigma: { x: 1, y: 1, z: 1 },
            cls: d.cls,
            confidence: d.score,
            positional: false,
            ray: { origin: pose.position, dir: ray },
            sharpness: d.sharpness,
          });
        }
      });
      out.frames.push(ref);
      break;
    }
    case 'drone.telemetry': {
      const p = env.payload;
      const pos = frame.toEnu(p.position);
      const vel = { x: p.velocity.ve, y: p.velocity.vn, z: p.velocity.vu };
      const o = { ...base(0, 'position'), position: pos, sigma: { x: 1, y: 1, z: 1.5 }, velocity: vel, state: 'CAPTURED' as const, payload: { ...p }, lat: p.position.lat, lon: p.position.lon };
      out.observations.push(o);
      if (p.mode !== 'docked')
        out.measurements.push({
          observationId: o.id,
          sensorId: env.sensorId,
          sensorKind: 'drone',
          localId: env.sensorId,
          t,
          position: pos,
          sigma: o.sigma,
          velocity: vel,
          cls: 'cooperative',
          entityId: `uas-${env.sensorId}`,
          label: p.callsign,
          confidence: 0.99,
          positional: true,
        });
      break;
    }
    case 'gps.position': {
      const p = env.payload;
      const pos = frame.toEnu(p.position);
      const o = { ...base(0, 'position'), position: pos, sigma: { x: p.accuracyM / 1.5, y: p.accuracyM / 1.5, z: 3 }, velocity: null, state: 'CAPTURED' as const, payload: { ...p }, lat: p.position.lat, lon: p.position.lon };
      out.observations.push(o);
      out.measurements.push({
        observationId: o.id,
        sensorId: env.sensorId,
        sensorKind: 'gps',
        localId: p.entityId,
        t,
        position: pos,
        sigma: o.sigma,
        cls: p.entityKind,
        entityId: p.entityId,
        label: p.callsign,
        confidence: 0.98,
        positional: true,
      });
      break;
    }
    case 'lidar.scan': {
      const p = env.payload;
      const pos = frame.toEnu(p.sensorPosition);
      out.observations.push({ ...base(0, 'spatial'), position: pos, sigma: null, velocity: null, state: 'CAPTURED', payload: { ...p }, lat: p.sensorPosition.lat, lon: p.sensorPosition.lon });
      break;
    }
    case 'imagery.capture': {
      const p = env.payload;
      out.observations.push({ ...base(0, 'imagery'), position: null, sigma: null, velocity: null, state: 'CAPTURED', payload: { ...p }, lat: null, lon: null });
      break;
    }
    case 'sensor.health': {
      out.observations.push({ ...base(0, 'health'), position: null, sigma: null, velocity: null, state: 'CAPTURED', payload: { ...env.payload }, lat: null, lon: null });
      break;
    }
    case 'infrastructure.state': {
      const p = env.payload;
      const pos = p.position ? frame.toEnu(p.position) : null;
      out.observations.push({ ...base(0, 'infrastructure'), position: pos, sigma: null, velocity: null, state: 'CAPTURED', payload: { ...p }, lat: p.position?.lat ?? null, lon: p.position?.lon ?? null });
      break;
    }
  }
  return out;
}

export const vecOrNull = (v: Vec3 | null) => (v ? [v.x, v.y, v.z] : [null, null, null]);
