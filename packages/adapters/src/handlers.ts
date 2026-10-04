import { CotStreamSplitter, cotToExternal, parseCot } from '@strata/domain';
import { decodeMav, flightMode, LinkQuality, MavParser, type MavMessage } from './mavlink.ts';
import { NmeaTracker, parseNmea } from './nmea.ts';

/** Where a handler sends envelopes (the ingest client, or a test sink). */
export type Emit = (sensorId: string, kind: string, payload: unknown, observedAt: number, idHint?: string) => void;

export interface HandlerStats {
  received: number;
  emitted: number;
  rejected: number;
  lastReason: string | null;
}

export interface Handler {
  /** Bytes from one source (`peer` distinguishes interleaved TCP clients / UDP senders). */
  data(chunk: Buffer, peer: string): void;
  stats: HandlerStats;
}

const newStats = (): HandlerStats => ({ received: 0, emitted: 0, rejected: 0, lastReason: null });

// --- NMEA 0183 -------------------------------------------------------------------------------------------

export interface NmeaEntity {
  entityId: string;
  entityKind: 'person' | 'vehicle';
  callsign: string;
  role: string;
}

export interface NmeaConfig {
  sensorId: string;
  /** Unit id prefix → entity (AVL forwarders). */
  entities?: Record<string, NmeaEntity>;
  /** Entity for unprefixed sentences (a single receiver on this port). */
  entity?: NmeaEntity;
  requireChecksum?: boolean;
  /** Minimum interval between reports per entity (ms). */
  minIntervalMs?: number;
}

export function nmeaHandler(cfg: NmeaConfig, emit: Emit): Handler {
  const stats = newStats();
  const trackers = new Map<string, NmeaTracker>();
  const partial = new Map<string, string>();
  const last = new Map<string, number>();
  return {
    stats,
    data(chunk, peer) {
      const text = (partial.get(peer) ?? '') + chunk.toString('latin1');
      const lines = text.split(/\r?\n/);
      partial.set(peer, (lines.pop() ?? '').slice(-512));
      for (const line of lines) {
        if (!line.trim()) continue;
        stats.received++;
        const r = parseNmea(line, { requireChecksum: cfg.requireChecksum ?? false });
        if (!r.ok) {
          // Unsupported sentence types (GSV, VTG…) are normal traffic, not errors.
          if (!r.reason.startsWith('unsupported')) {
            stats.rejected++;
            stats.lastReason = r.reason;
          }
          continue;
        }
        const ent = r.fix.unit ? cfg.entities?.[r.fix.unit] : cfg.entity;
        if (!ent) {
          stats.rejected++;
          stats.lastReason = `no entity mapping for unit ${r.fix.unit ?? '(none)'}`;
          continue;
        }
        const key = `${peer}|${r.fix.unit ?? ''}`;
        let tr = trackers.get(key);
        if (!tr) trackers.set(key, (tr = new NmeaTracker()));
        const rep = tr.push(r.fix);
        if (!rep) continue;
        const prev = last.get(ent.entityId) ?? 0;
        if (rep.time - prev < (cfg.minIntervalMs ?? 1000)) continue;
        last.set(ent.entityId, rep.time);
        emit(
          cfg.sensorId,
          'gps.position',
          {
            entityId: ent.entityId,
            entityKind: ent.entityKind,
            callsign: ent.callsign,
            role: ent.role,
            status: 'available',
            position: { lat: rep.lat, lon: rep.lon, alt: rep.altM ?? 0 },
            accuracyM: Math.min(1000, rep.accuracyM),
            ...(rep.speedMps !== null ? { speedMps: Math.min(200, rep.speedMps) } : {}),
            ...(rep.courseDeg !== null && rep.speedMps !== null && rep.speedMps > 0.5 ? { headingDeg: rep.courseDeg % 360 } : {}),
          },
          rep.time,
          ent.entityId,
        );
        stats.emitted++;
      }
    },
  };
}

// --- MAVLink -----------------------------------------------------------------------------------------------

export interface MavVehicle {
  sensorId: string;
  callsign: string;
  /** Camera horizontal field of view (deg) for the gimbal footprint; default 70. */
  hfovDeg?: number;
  /** Fixed camera pitch when the vehicle reports no gimbal attitude; default -45. */
  gimbalPitchDeg?: number;
}

export interface MavConfig {
  /** MAVLink system id → platform sensor. Unmapped system ids are ignored (and counted). */
  vehicles: Record<string, MavVehicle>;
  minIntervalMs?: number;
}

interface VehicleState {
  hb?: Extract<MavMessage, { type: 'HEARTBEAT' }>;
  sys?: Extract<MavMessage, { type: 'SYS_STATUS' }>;
  att?: Extract<MavMessage, { type: 'ATTITUDE' }>;
  gimbal?: { pitch: number; yaw: number };
  lastEmit: number;
  link: LinkQuality;
}

export function mavlinkHandler(cfg: MavConfig, emit: Emit, now: () => number = Date.now): Handler {
  const stats = newStats();
  const parsers = new Map<string, MavParser>();
  const state = new Map<number, VehicleState>();
  return {
    stats,
    data(chunk, peer) {
      let p = parsers.get(peer);
      if (!p) parsers.set(peer, (p = new MavParser()));
      const before = p.stats.crcErrors;
      for (const f of p.push(chunk)) {
        stats.received++;
        const veh = cfg.vehicles[String(f.sysid)];
        if (!veh) {
          stats.lastReason = `unmapped MAVLink system id ${f.sysid}`;
          continue;
        }
        let st = state.get(f.sysid);
        if (!st) state.set(f.sysid, (st = { lastEmit: 0, link: new LinkQuality() }));
        st.link.frame(f);
        const m = decodeMav(f);
        if (!m) continue;
        if (m.type === 'HEARTBEAT') {
          if (f.compid === 1 || !st.hb) st.hb = m; // autopilot component wins over e.g. a gimbal's heartbeat
        } else if (m.type === 'SYS_STATUS') st.sys = m;
        else if (m.type === 'ATTITUDE') st.att = m;
        else if (m.type === 'GIMBAL_DEVICE_ATTITUDE_STATUS') {
          const [w, x, y, z] = m.q;
          if (Number.isFinite(w)) {
            const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))) * (180 / Math.PI);
            const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * (180 / Math.PI);
            st.gimbal = { pitch, yaw };
          }
        } else if (m.type === 'GLOBAL_POSITION_INT') {
          const t = now();
          if (t - st.lastEmit < (cfg.minIntervalMs ?? 1000)) continue;
          if (m.lat === 0 && m.lon === 0) {
            stats.rejected++;
            stats.lastReason = 'no position fix (0,0)';
            continue;
          }
          st.lastEmit = t;
          const heading = m.hdgDeg ?? (st.att ? (st.att.yaw + 360) % 360 : 0);
          const gimbalHeading = st.gimbal ? (heading + st.gimbal.yaw + 360) % 360 : heading;
          emit(
            veh.sensorId,
            'drone.telemetry',
            {
              callsign: veh.callsign,
              position: { lat: m.lat, lon: m.lon, alt: Math.max(-500, Math.min(60000, m.altM)) },
              velocity: { ve: m.ve, vn: m.vn, vu: -m.vd },
              attitude: { headingDeg: heading, pitchDeg: st.att?.pitch ?? 0, rollDeg: st.att?.roll ?? 0 },
              gimbal: { headingDeg: gimbalHeading, pitchDeg: Math.max(-90, Math.min(90, st.gimbal?.pitch ?? veh.gimbalPitchDeg ?? -45)), hfovDeg: veh.hfovDeg ?? 70 },
              ...(st.sys && st.sys.batteryRemaining >= 0 ? { batteryPct: Math.min(100, st.sys.batteryRemaining) } : {}),
              mode: st.hb ? flightMode(st.hb) : 'transit',
              linkQuality: st.link.value,
            },
            t,
            `${f.sysid}-${m.timeBootMs}`,
          );
          stats.emitted++;
        }
      }
      const crc = p.stats.crcErrors - before;
      if (crc > 0) {
        stats.rejected += crc;
        stats.lastReason = 'MAVLink CRC error';
      }
    },
  };
}

// --- Cursor-on-Target --------------------------------------------------------------------------------------

export interface CotConfig {
  sensorId: string;
  system?: string;
  /** Ignore events whose uid starts with any of these (e.g. this platform's own output, to avoid echo). */
  ignoreUidPrefixes?: string[];
  /** Accept only these affiliations (default all). */
  affiliations?: string[];
}

export function cotHandler(cfg: CotConfig, emit: Emit, now: () => number = Date.now): Handler {
  const stats = newStats();
  const splitters = new Map<string, CotStreamSplitter>();
  const ignore = cfg.ignoreUidPrefixes ?? ['strata.'];
  return {
    stats,
    data(chunk, peer) {
      let sp = splitters.get(peer);
      if (!sp) splitters.set(peer, (sp = new CotStreamSplitter()));
      for (const xml of sp.push(chunk.toString('utf8'))) {
        stats.received++;
        const r = parseCot(xml);
        if (!r.ok) {
          stats.rejected++;
          stats.lastReason = r.reason;
          continue;
        }
        const ev = r.event;
        if (ignore.some((p) => ev.uid.startsWith(p))) continue;
        const ext = cotToExternal(ev, cfg.system ?? 'CoT');
        if (!ext) continue; // not a track (b-, t-, u- types)
        if (cfg.affiliations && !cfg.affiliations.includes(ext.affiliation)) continue;
        // Old events are history, not a live picture; the platform rejects far-future time stamps itself.
        if (ev.stale !== null && ev.stale < now() - 3_600_000) {
          stats.rejected++;
          stats.lastReason = 'event stale for over an hour';
          continue;
        }
        emit(cfg.sensorId, 'external.track', ext, ev.time, ev.uid.slice(0, 40));
        stats.emitted++;
      }
    },
  };
}
