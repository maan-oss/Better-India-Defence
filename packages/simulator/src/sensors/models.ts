import {
  FACILITY,
  cameraBasis,
  castScan,
  encodeScan,
  gaussianAt,
  getBms,
  getCameras,
  getDrones,
  getFenceSensors,
  getLidars,
  getRadars,
  getRfSensors,
  getSatellite,
  hash01,
  hashString,
  lineOfSight,
  normalizeVec,
  projectPoint,
  type CameraDef,
  type CameraDetection,
  type CameraPose,
  type DroneDef,
  type IngestEnvelope,
  type LidarDef,
  type RangeScan,
  type ScanGeometry,
  type SolidBox,
  type Vec3,
} from '@strata/domain';
import { envelope, round, sensorHash, toGeo } from './common.ts';
import type { EntityState, TruthWorld, WorldObject } from '../truth/world.ts';
import { EPOCH } from '../time.ts';

export interface MediaUpload {
  mediaId: string;
  sensorId: string;
  kind: 'pointcloud' | 'imagery';
  contentType: string;
  capturedAt: number;
  body: Uint8Array;
  meta: Record<string, unknown>;
}

export interface StepOutput {
  messages: IngestEnvelope[];
  media: MediaUpload[];
}

export interface OrthoRenderer {
  (world: TruthWorld, t: number, gsdM: number, halfExtentM: number): { png: Uint8Array; width: number; height: number };
}

const sec = (t: number) => Math.floor((t - EPOCH) / 1000);
const due = (t: number, periodS: number, phaseS: number) => (((sec(t) - phaseS) % periodS) + periodS) % periodS === 0;
const g = (...k: number[]) => gaussianAt(...k);

// ------------------------------------------------------------------------------------------------ radar

export function radarStep(world: TruthWorld, t: number, entities: EntityState[]): IngestEnvelope[] {
  const out: IngestEnvelope[] = [];
  getRadars().forEach((r, ri) => {
    if (!due(t, r.updatePeriodS, ri % r.updatePeriodS)) return;
    const outage = world.outage(r.id, t);
    if (outage?.kind === 'offline') return;
    const degraded = outage?.kind === 'degraded';
    const index = world.staticIndex(t);
    const sh = sensorHash(r.id);
    const plots: Extract<IngestEnvelope, { kind: 'radar.track' }>['payload']['plots'] = [];
    for (const { entity, state } of entities) {
      if (entity.kind !== 'drone' && entity.kind !== 'bird') continue;
      const p = state.position;
      const agl = p.z - (state.mode === 'docked' ? p.z : 0);
      if (state.mode === 'docked' || agl < r.minAltitudeM) continue;
      const dx = p.x - r.position.x;
      const dy = p.y - r.position.y;
      const dz = p.z - r.position.z;
      const range = Math.hypot(dx, dy, dz);
      if (range > r.rangeM) continue;
      if (!lineOfSight(index, r.position, p)) continue;
      // Detection model: reference detection range scales with RCS^(1/4) (radar equation); Pd ≈ 0.95 inside
      // 70 % of that range, falling linearly to 0 at 130 %. Degraded transmitters lose 40 % of range.
      const refRange = 5000 * Math.pow(10, (entity.rcsDbsm + 10) / 40) * (degraded ? 0.6 : 1);
      const pd = Math.max(0, Math.min(0.95, 0.95 * (1.3 * refRange - range) / (0.6 * refRange)));
      const eh = hashString(entity.id) % 100_000;
      if (hash01(sh, sec(t), eh) > pd) continue;
      const k = degraded ? 2 : 1;
      const rn = range + g(sh, sec(t), eh, 1) * r.sigmaRangeM * k;
      const az = Math.atan2(dx, dy) + (g(sh, sec(t), eh, 2) * r.sigmaAzDeg * k * Math.PI) / 180;
      const el = Math.asin(dz / range) + (g(sh, sec(t), eh, 3) * r.sigmaElDeg * k * Math.PI) / 180;
      const meas: Vec3 = {
        x: r.position.x + rn * Math.cos(el) * Math.sin(az),
        y: r.position.y + rn * Math.cos(el) * Math.cos(az),
        z: r.position.z + rn * Math.sin(el),
      };
      plots.push({
        localTrackId: String((eh % 900) + 100),
        position: toGeo(meas),
        velocity: { ve: round(state.velocity.x + g(sh, sec(t), eh, 4) * 0.6, 2), vn: round(state.velocity.y + g(sh, sec(t), eh, 5) * 0.6, 2), vu: round(state.velocity.z + g(sh, sec(t), eh, 6) * 0.4, 2) },
        rangeM: round(rn, 1),
        azimuthDeg: round(((az * 180) / Math.PI + 360) % 360, 3),
        elevationDeg: round((el * 180) / Math.PI, 3),
        rcsDbsm: round(entity.rcsDbsm + g(sh, sec(t), eh, 7) * 2, 1),
        confidence: round(Math.min(0.99, 0.5 + pd / 2), 2),
        sigma: { rangeM: r.sigmaRangeM * k, azDeg: r.sigmaAzDeg * k, elDeg: r.sigmaElDeg * k },
      });
    }
    // Clutter: an occasional isolated false plot (should only ever form a tentative track).
    const window = Math.floor(sec(t) / 240);
    if (hash01(sh, window, 99) < 0.5 && Math.floor(hash01(sh, window, 98) * 120) === Math.floor((sec(t) % 240) / 2)) {
      const ang = hash01(sh, window, 97) * 2 * Math.PI;
      const rr = 800 + hash01(sh, window, 96) * 2500;
      const c = { x: r.position.x + rr * Math.cos(ang), y: r.position.y + rr * Math.sin(ang), z: 25 + hash01(sh, window, 95) * 30 };
      plots.push({
        localTrackId: `C${window % 1000}`,
        position: toGeo(c),
        velocity: { ve: 0, vn: 0, vu: 0 },
        rangeM: round(rr, 1),
        azimuthDeg: round(((Math.atan2(c.x - r.position.x, c.y - r.position.y) * 180) / Math.PI + 360) % 360, 3),
        elevationDeg: 0.5,
        rcsDbsm: -18,
        confidence: 0.35,
        sigma: { rangeM: r.sigmaRangeM, azDeg: r.sigmaAzDeg, elDeg: r.sigmaElDeg },
      });
    }
    out.push(envelope('radar.track', r.id, 'radar.generic-asterix-bridge.v1', t, { scanId: sec(t), plots }));
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ RF

export function rfStep(world: TruthWorld, t: number, entities: EntityState[]): IngestEnvelope[] {
  const out: IngestEnvelope[] = [];
  for (const rf of getRfSensors()) {
    if (!due(t, 2, 1)) continue;
    if (world.outage(rf.id, t)) continue;
    const sh = sensorHash(rf.id);
    const emissions: Extract<IngestEnvelope, { kind: 'rf.detection' }>['payload']['emissions'] = [];
    for (const { entity, state } of entities) {
      if (!entity.emitters.length) continue;
      const d = Math.hypot(state.position.x - rf.position.x, state.position.y - rf.position.y);
      if (d > rf.rangeM) continue;
      const eh = hashString(entity.id) % 100_000;
      entity.emitters.forEach((em, i) => {
        const fspl = 20 * Math.log10(Math.max(d, 10) / 1000) + 20 * Math.log10(em.centerMHz) + 32.44;
        const rssi = em.eirpDbm - fspl + g(sh, sec(t), eh, i, 1) * 2;
        if (rssi < -95) return;
        const sigma = 60 + 0.05 * d;
        const c = { x: state.position.x + g(sh, sec(t), eh, i, 2) * sigma, y: state.position.y + g(sh, sec(t), eh, i, 3) * sigma, z: 0 };
        emissions.push({
          emitterId: `E${(eh % 9000) + 1000}-${i}`,
          centerFrequencyMHz: em.centerMHz + round(g(sh, sec(t), eh, i, 4) * 3, 1),
          bandwidthMHz: em.bandwidthMHz,
          rssiDbm: round(rssi, 1),
          modulation: em.modulation,
          protocolClass: em.protocolClass,
          region: { center: toGeo(c), radiusM: round(2 * sigma, 0) },
          confidence: round(Math.min(0.95, Math.max(0.3, (rssi + 100) / 40)), 2),
        });
      });
    }
    if (emissions.length) out.push(envelope('rf.detection', rf.id, 'rf.passive-df.v1', t, { emissions }));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ cameras

export function cameraPoseAt(cam: CameraDef, t: number): CameraPose {
  // Mast sway: sub-pixel pointing jitter. It is NOT reported in calibration (the real world doesn't tell you).
  const s = sec(t);
  const h = sensorHash(cam.id);
  return {
    position: cam.position,
    headingDeg: cam.headingDeg + 0.012 * Math.sin(s * 0.7 + h) + 0.006 * g(h, s, 11),
    pitchDeg: cam.pitchDeg + 0.008 * Math.cos(s * 0.9 + h) + 0.004 * g(h, s, 12),
    hfovDeg: cam.hfovDeg,
    widthPx: cam.widthPx,
    heightPx: cam.heightPx,
  };
}

export function dronePose(d: DroneDef, state: { position: Vec3; headingRad: number }): CameraPose {
  return {
    position: state.position,
    headingDeg: (90 - (state.headingRad * 180) / Math.PI + 360) % 360,
    pitchDeg: d.gimbalPitchDeg,
    hfovDeg: d.cameraHfovDeg,
    widthPx: 1920,
    heightPx: 1080,
  };
}

function boxCorners(b: SolidBox): Vec3[] {
  const yaw = (b.yawDeg * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const out: Vec3[] = [];
  for (const lx of [-b.width / 2, b.width / 2])
    for (const ly of [-b.depth / 2, b.depth / 2])
      for (const z of [b.z0, b.z0 + b.height]) out.push({ x: b.center.x + lx * c - ly * s, y: b.center.y + lx * s + ly * c, z });
  return out;
}

function bboxOf(pose: CameraPose, box: SolidBox): [number, number, number, number] | null {
  const basis = cameraBasis(pose);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of boxCorners(box)) {
    const pr = projectPoint(pose, p, basis);
    if (!pr) return null;
    x0 = Math.min(x0, pr.u);
    y0 = Math.min(y0, pr.v);
    x1 = Math.max(x1, pr.u);
    y1 = Math.max(y1, pr.v);
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(pose.widthPx, x1);
  y1 = Math.min(pose.heightPx, y1);
  if (x1 <= x0 || y1 <= y0) return null;
  return [round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)];
}

function detectFrom(
  world: TruthWorld,
  sensorId: string,
  pose: CameraPose,
  rangeM: number,
  t: number,
  entities: EntityState[],
  objects: WorldObject[] | null,
): CameraDetection[] {
  const index = world.staticIndex(t);
  const sh = sensorHash(sensorId);
  const dets: CameraDetection[] = [];
  const consider = (id: string, box: SolidBox, cls: CameraDetection['cls'], kindForSize: 'small' | 'normal', extra: Partial<CameraDetection>, isStatic: boolean) => {
    const center: Vec3 = { x: box.center.x, y: box.center.y, z: box.z0 + box.height / 2 };
    const pr = projectPoint(pose, center);
    if (!pr || pr.depth > rangeM) return;
    if (pr.u < 0 || pr.u > pose.widthPx || pr.v < 0 || pr.v > pose.heightPx) return;
    if (!lineOfSight(index, pose.position, center, id)) return;
    const bb = bboxOf(pose, box);
    if (!bb) return;
    const size = Math.max(bb[2], bb[3]);
    const minPx = kindForSize === 'small' ? 4 : 8;
    if (size < minPx) return;
    const eh = hashString(id) % 100_000;
    const pd = Math.min(0.97, (size - minPx + 1) / 10);
    if (hash01(sh, sec(t), eh, 21) > pd) return;
    let finalCls = cls;
    if ((cls === 'drone' || cls === 'bird') && size < 14) finalCls = 'unknown';
    dets.push({
      localTrackId: isStatic ? `S${eh % 10000}` : String(eh % 10000),
      cls: finalCls,
      bbox: bb,
      score: round(Math.min(0.98, 0.35 + size / 80), 2),
      sharpness: round(Math.max(0.05, Math.min(1, bb[3] / 240)), 3),
      isStatic,
      ...extra,
    });
  };
  for (const e of entities) {
    if (!e.state.visible) continue;
    if (e.state.mode === 'docked' && e.entity.kind === 'drone') continue;
    const box = world.entityBox(e);
    if (Math.hypot(box.center.x - pose.position.x, box.center.y - pose.position.y) < 2) continue; // self
    const cls: CameraDetection['cls'] = e.entity.kind === 'person' ? 'person' : e.entity.kind === 'vehicle' ? 'vehicle' : e.entity.kind === 'bird' ? 'bird' : 'drone';
    const extra: Partial<CameraDetection> = {};
    if (e.entity.signature) {
      const bb = bboxOf(pose, box);
      const hpx = bb ? bb[3] : 0;
      const sharp = Math.max(0.05, Math.min(1, hpx / 240));
      const eh = hashString(e.entity.id) % 100_000;
      const noise = 0.06 + 0.55 * (1 - sharp);
      extra.appearance = normalizeVec(e.entity.signature.map((v, i) => v + noise * g(sh, sec(t), eh, 30 + i))).map((v) => round(v, 4));
      const toCam = Math.atan2(pose.position.y - e.state.position.y, pose.position.x - e.state.position.x);
      const facing = Math.max(0, Math.cos(toCam - e.state.headingRad));
      extra.faceQuality = round(Math.max(0, Math.min(1, (hpx - 120) / 420)) * facing, 3);
    }
    consider(e.entity.id, box, cls, e.entity.kind === 'drone' || e.entity.kind === 'bird' ? 'small' : 'normal', extra, false);
  }
  if (objects) {
    for (const o of objects) {
      const box = world.staticBoxes(t).find((b) => b.id === o.id);
      if (!box) continue;
      const cls: CameraDetection['cls'] = o.kind === 'debris' ? 'debris' : o.kind === 'parked_vehicle' ? 'vehicle' : 'unknown';
      if (o.kind === 'light_mast' || o.kind === 'barrier') continue;
      consider(o.id, box, cls, 'normal', {}, true);
    }
  }
  return dets;
}

export function cameraStep(world: TruthWorld, t: number, entities: EntityState[]): IngestEnvelope[] {
  const out: IngestEnvelope[] = [];
  const objects = world.objectsAt(t);
  for (const cam of getCameras()) {
    const ch = sensorHash(cam.id);
    if (!due(t, 2, ch % 2)) continue;
    if (world.outage(cam.id, t)?.kind === 'offline') continue;
    const pose = cameraPoseAt(cam, t);
    const keyframe = due(t, 30, ch % 30) || due(t, 30, (ch % 30) + 1);
    const detections = detectFrom(world, cam.id, pose, cam.rangeM, t, entities, keyframe ? objects : null);
    if (!detections.length && !due(t, 10, ch % 10) && !due(t, 10, (ch % 10) + 1)) continue;
    out.push(
      envelope('camera.detections', cam.id, 'vms.onvif-analytics-bridge.v1', t, {
        frameId: `${cam.id}-${t}`,
        pose: { position: toGeo(cam.position), headingDeg: cam.headingDeg, pitchDeg: cam.pitchDeg, hfovDeg: cam.hfovDeg, widthPx: cam.widthPx, heightPx: cam.heightPx },
        detections,
      }),
    );
  }
  for (const d of getDrones()) {
    if (!due(t, 2, 0)) continue;
    const state = world.droneState(d.id, t);
    if (!state || state.mode === 'docked') continue;
    const pose = dronePose(d, state);
    const detections = detectFrom(world, d.id, pose, 600, t, entities.filter((e) => e.entity.telemetryId !== d.id), null);
    out.push(
      envelope('camera.detections', d.id, 'uas.gimbal-analytics.v1', t, {
        frameId: `${d.id}-${t}`,
        pose: { position: toGeo(pose.position), headingDeg: round(pose.headingDeg, 3), pitchDeg: pose.pitchDeg, hfovDeg: pose.hfovDeg, widthPx: pose.widthPx, heightPx: pose.heightPx },
        detections,
      }, 1),
    );
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ GPS / telemetry

export function gpsStep(_world: TruthWorld, t: number, entities: EntityState[], contradict: { entityId: string; dx: number; dy: number } | null): IngestEnvelope[] {
  const out: IngestEnvelope[] = [];
  let sub = 0;
  for (const { entity, state } of entities) {
    if (!entity.gps) continue;
    const eh = hashString(entity.id) % 100_000;
    if (!due(t, entity.gps.periodS, eh % entity.gps.periodS)) continue;
    const indoor = !state.visible;
    const sigma = indoor ? 9 : 2;
    let p = { x: state.position.x + g(eh, sec(t), 41) * sigma, y: state.position.y + g(eh, sec(t), 42) * sigma, z: state.position.z };
    if (contradict && contradict.entityId === entity.id) p = { x: p.x + contradict.dx, y: p.y + contradict.dy, z: p.z };
    const speed = Math.hypot(state.velocity.x, state.velocity.y);
    out.push(
      envelope('gps.position', 'GPS1', 'gps.lora-tracker-gateway.v1', t, {
        entityId: entity.id,
        entityKind: entity.gps.entityKind,
        callsign: entity.gps.callsign,
        role: entity.role,
        status: 'available',
        position: toGeo(p),
        accuracyM: indoor ? 15 : 3,
        speedMps: round(speed, 2),
        headingDeg: round(((90 - (state.headingRad * 180) / Math.PI) % 360 + 360) % 360, 1),
      }, sub++ % 16),
    );
  }
  return out;
}

/**
 * EXT1: a neighbouring unit's TAK picture over Cursor-on-Target, every 10 s. It reports its own friendly
 * patrol outside the wire and, from its observation post, non-cooperative vehicles on the approaches as
 * "suspect" — coarser (25 m) than the site's own sensors, so fusion must associate rather than duplicate.
 */
export function externalStep(_world: TruthWorld, t: number, entities: EntityState[]): IngestEnvelope[] {
  if (!due(t, 10, 7)) return [];
  const out: IngestEnvelope[] = [];
  const P = FACILITY.perimeterHalfM;
  // Friendly patrol on a slow loop 150 m outside the perimeter.
  const a = ((sec(t) % 1800) / 1800) * 2 * Math.PI;
  const r = P + 150;
  const pos = { x: r * Math.cos(a), y: r * Math.sin(a), z: 0 };
  out.push(
    envelope('external.track', 'EXT1', 'tak.cot-bridge.v1', t, {
      system: 'TAK',
      uid: 'ANDROID-7f3c21-BRAVO2',
      callsign: 'BRAVO-2',
      affiliation: 'friend',
      category: 'person',
      position: toGeo(pos),
      ceM: 6,
      courseDeg: round(((90 - ((a + Math.PI / 2) * 180) / Math.PI) % 360 + 360) % 360, 1),
      speedMps: round((2 * Math.PI * r) / 1800, 2),
      type: 'a-f-G-U-C-I',
      staleAt: t + 30_000,
    }, 0),
  );
  let sub = 1;
  for (const { entity, state } of entities) {
    if (entity.gps || entity.telemetryId || entity.kind !== 'vehicle') continue;
    const { x, y } = state.position;
    if (Math.max(Math.abs(x), Math.abs(y)) < P + 20 || Math.max(Math.abs(x), Math.abs(y)) > FACILITY.halfExtentM) continue;
    const eh = sensorHash(entity.id);
    const speed = Math.hypot(state.velocity.x, state.velocity.y);
    out.push(
      envelope('external.track', 'EXT1', 'tak.cot-bridge.v1', t, {
        system: 'TAK',
        uid: `OP-NORTH.${entity.id}`,
        affiliation: 'suspect',
        category: 'vehicle',
        position: toGeo({ x: x + g(eh, sec(t), 61) * 15, y: y + g(eh, sec(t), 62) * 15, z: 0 }),
        ceM: 25,
        ...(speed > 0.5 ? { courseDeg: round(((90 - (Math.atan2(state.velocity.y, state.velocity.x) * 180) / Math.PI) % 360 + 360) % 360, 1), speedMps: round(speed, 1) } : {}),
        type: 'a-s-G-E-V',
        staleAt: t + 30_000,
        remarks: 'Unidentified vehicle on approach road (OP North)',
      }, sub++ % 16),
    );
  }
  return out;
}

export function droneTelemetryStep(world: TruthWorld, t: number): IngestEnvelope[] {
  const out: IngestEnvelope[] = [];
  for (const d of getDrones()) {
    const s = world.droneState(d.id, t);
    if (!s) continue;
    const docked = s.mode === 'docked';
    if (docked && !due(t, 10, 3)) continue;
    const dh = sensorHash(d.id);
    const heading = ((90 - (s.headingRad * 180) / Math.PI) % 360 + 360) % 360;
    const cycleMin = ((sec(t) % 3600) / 60) | 0;
    out.push(
      envelope('drone.telemetry', d.id, 'uas.mavlink-bridge.v1', t, {
        callsign: d.callsign,
        position: toGeo({ x: s.position.x + g(dh, sec(t), 51) * 0.5, y: s.position.y + g(dh, sec(t), 52) * 0.5, z: s.position.z + g(dh, sec(t), 53) * 0.3 }),
        velocity: { ve: round(s.velocity.x, 2), vn: round(s.velocity.y, 2), vu: round(s.velocity.z, 2) },
        attitude: { headingDeg: round(heading, 1), pitchDeg: docked ? 0 : -4, rollDeg: 0 },
        gimbal: { headingDeg: round(heading, 1), pitchDeg: d.gimbalPitchDeg, hfovDeg: d.cameraHfovDeg },
        batteryPct: docked ? 100 : Math.max(20, 96 - cycleMin * 1.2),
        mode: s.mode === 'docked' ? 'docked' : s.mode === 'loiter' ? 'loiter' : s.mode === 'survey' ? 'survey' : s.mode === 'rtb' ? 'rtb' : s.mode === 'transit' ? 'transit' : 'patrol',
        linkQuality: round(0.9 + 0.08 * Math.sin(sec(t) / 30 + dh), 2),
      }, 2),
    );
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ infrastructure / health

export function infrastructureStep(world: TruthWorld, t: number, entities: EntityState[]): IngestEnvelope[] {
  const out: IngestEnvelope[] = [];
  const active = world.infrastructureAt(t);
  let sub = 3;
  for (const fs of getFenceSensors()) {
    if (world.outage(fs.id, t)) continue;
    for (const segId of fs.fenceSegmentIds) {
      const ev = active.find((a) => a.assetId === segId);
      if (ev ? !due(t, 10, 0) : !due(t, 60, sensorHash(segId) % 60)) continue;
      out.push(
        envelope('infrastructure.state', fs.id, 'pids.fence-vibration.v1', t, {
          assetId: segId,
          assetKind: 'fence',
          state: ev ? ev.state : 'secure',
          alarm: ev ? ev.alarm : false,
          ...(ev?.detail ? { detail: ev.detail } : {}),
          ...(ev?.position ? { position: toGeo({ x: ev.position.x, y: ev.position.y, z: 0 }) } : {}),
        }, sub++ % 16),
      );
    }
  }
  const bms = getBms();
  if (bms) {
    for (const a of bms.assets) {
      const ev = active.find((x) => x.assetId === a.id);
      let state = a.kind === 'gate' ? 'closed' : a.kind === 'power' ? 'normal' : 'up';
      let alarm = false;
      if (a.kind === 'gate') {
        const near = entities.some((e) => e.entity.kind === 'vehicle' && Math.hypot(e.state.position.x - a.position.x, e.state.position.y - a.position.y) < 90);
        if (near) state = 'open';
      }
      if (ev) {
        state = ev.state;
        alarm = ev.alarm;
      }
      const ah = sensorHash(a.id);
      if (!due(t, 20, ah % 20)) continue;
      out.push(envelope('infrastructure.state', bms.id, 'bms.modbus-gateway.v1', t, { assetId: a.id, assetKind: a.kind, state, alarm, ...(ev?.detail ? { detail: ev.detail } : {}) }, sub++ % 16));
    }
  }
  return out;
}

export function healthStep(world: TruthWorld, t: number): IngestEnvelope[] {
  const out: IngestEnvelope[] = [];
  for (const s of FACILITY.sensors) {
    const h = sensorHash(s.id);
    if (!due(t, 15, h % 15)) continue;
    const o = world.outage(s.id, t);
    if (o?.kind === 'offline') continue;
    if (s.kind === 'satellite') continue; // tasked space asset: no heartbeat, only deliveries
    const metrics: Record<string, number> = { cpuPct: round(20 + 10 * Math.sin(sec(t) / 300 + h), 1) };
    if (s.kind === 'camera') metrics.fps = 15;
    if (s.kind === 'radar') metrics.txPowerPct = o ? 55 : 100;
    out.push(
      envelope('sensor.health', s.id, 'health.snmp-bridge.v1', t, {
        status: o?.kind === 'degraded' ? 'degraded' : 'ok',
        uptimeS: Math.max(0, sec(t) % 86400),
        temperatureC: round(34 + 4 * Math.sin(sec(t) / 900 + h), 1),
        ...(o ? { message: o.reason } : {}),
        metrics,
      }, 15),
    );
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ LiDAR

function lidarGeometry(l: LidarDef): ScanGeometry {
  return {
    origin: l.position,
    azimuthSteps: l.azimuthSteps,
    elevationSteps: l.elevationSteps,
    elevationMinDeg: l.elevationMinDeg,
    elevationMaxDeg: l.elevationMaxDeg,
    maxRangeM: l.rangeM,
  };
}

function scan(world: TruthWorld, sensorId: string, geom: ScanGeometry, t: number): MediaUpload {
  const sh = sensorHash(sensorId);
  const index = world.staticIndex(t);
  const { ranges } = castScan(geom, index, world.entityBoxes(t), (i) => 0.03 * g(sh, sec(t), i, 61));
  const s: RangeScan = { ...geom, sensorId, scanId: `${sensorId}-${t}`, t, ranges };
  return {
    mediaId: `${sensorId}-scan-${t}`,
    sensorId,
    kind: 'pointcloud',
    contentType: 'application/x-strata-rangescan',
    capturedAt: t,
    body: encodeScan(s),
    meta: { azimuthSteps: geom.azimuthSteps, elevationSteps: geom.elevationSteps, frame: 'site-enu' },
  };
}

export function lidarStep(world: TruthWorld, t: number): StepOutput {
  const messages: IngestEnvelope[] = [];
  const media: MediaUpload[] = [];
  getLidars().forEach((l, i) => {
    const scheduled = due(t, l.scanPeriodS, i * 200);
    const extra = world.extraLidarScans(l.id, t, t + 1000).length > 0;
    if (!scheduled && !extra) return;
    if (world.outage(l.id, t)?.kind === 'offline') return;
    const m = scan(world, l.id, lidarGeometry(l), t);
    media.push(m);
    messages.push(
      envelope('lidar.scan', l.id, 'lidar.static-scanner.v1', t, {
        scanId: `${l.id}-${t}`,
        sensorPosition: toGeo(l.position),
        mediaId: m.mediaId,
        pointCount: l.azimuthSteps * l.elevationSteps,
        rangeM: l.rangeM,
        durationMs: 100,
        frame: 'site-enu',
      }),
    );
  });
  for (const d of getDrones()) {
    if (!d.hasLidar) continue;
    for (const w of world.droneLidarWindows(d.id)) {
      if (t < w.from || t > w.to || ((t - w.from) / 1000) % w.periodS !== 0) continue;
      const s = world.droneState(d.id, t);
      if (!s) continue;
      const geom: ScanGeometry = { origin: s.position, azimuthSteps: 512, elevationSteps: 24, elevationMinDeg: -88, elevationMaxDeg: -15, maxRangeM: 160 };
      const m = scan(world, d.id, geom, t);
      media.push(m);
      messages.push(envelope('lidar.scan', d.id, 'uas.lidar-payload.v1', t, { scanId: `${d.id}-${t}`, sensorPosition: toGeo(s.position), mediaId: m.mediaId, pointCount: 512 * 24, rangeM: 160, durationMs: 100, frame: 'site-enu' }, 3));
    }
  }
  return { messages, media };
}

// ------------------------------------------------------------------------------------------------ satellite

export function satelliteStep(world: TruthWorld, t: number, render: OrthoRenderer): StepOutput {
  const sat = getSatellite();
  if (!sat) return { messages: [], media: [] };
  const acquiredAt = t - sat.deliveryLatencyS * 1000;
  if (!due(acquiredAt, sat.revisitS, sat.phaseS)) return { messages: [], media: [] };
  const half = FACILITY.halfExtentM;
  const { png, width, height } = render(world, acquiredAt, sat.groundSampleDistanceM, half);
  const mediaId = `${sat.id}-${acquiredAt}`;
  const cloud = Math.round(hash01(sensorHash(sat.id), sec(acquiredAt), 71) * 12);
  const env = envelope('imagery.capture', sat.id, 'eo.provider-delivery.v1', acquiredAt, {
    captureId: mediaId,
    mediaId,
    acquiredAt,
    gsdM: sat.groundSampleDistanceM,
    footprint: { sw: toGeo({ x: -half, y: -half, z: 0 }), ne: toGeo({ x: half, y: half, z: 0 }) },
    widthPx: width,
    heightPx: height,
    cloudCoverPct: cloud,
    sunElevationDeg: 52,
    processingLevel: 'L2',
  });
  env.sentAt = t;
  return {
    messages: [env],
    media: [{ mediaId, sensorId: sat.id, kind: 'imagery', contentType: 'image/png', capturedAt: acquiredAt, body: png, meta: { gsdM: sat.groundSampleDistanceM, deliveredAt: t } }],
  };
}
