/**
 * MAVLink v1/v2 frame parser (common dialect subset) for UAS telemetry. RECEIVE-ONLY: this adapter never
 * sends commands to a vehicle. Frames are CRC-checked with the per-message CRC_EXTRA; unknown message ids are
 * counted and skipped (their CRC cannot be verified without the dialect definition).
 *
 * Decoded: HEARTBEAT (0), SYS_STATUS (1), ATTITUDE (30), GLOBAL_POSITION_INT (33), VFR_HUD (74),
 * GIMBAL_DEVICE_ATTITUDE_STATUS (285, gimbal pitch/yaw).
 */
export interface MavFrame {
  version: 1 | 2;
  seq: number;
  sysid: number;
  compid: number;
  msgid: number;
  payload: Buffer;
  signed: boolean;
}

export type MavMessage =
  | { type: 'HEARTBEAT'; customMode: number; mavType: number; autopilot: number; baseMode: number; systemStatus: number }
  | { type: 'SYS_STATUS'; voltageMv: number; currentCa: number; batteryRemaining: number; dropRateComm: number }
  | { type: 'ATTITUDE'; timeBootMs: number; roll: number; pitch: number; yaw: number }
  | { type: 'GLOBAL_POSITION_INT'; timeBootMs: number; lat: number; lon: number; altM: number; relAltM: number; vn: number; ve: number; vd: number; hdgDeg: number | null }
  | { type: 'VFR_HUD'; airspeed: number; groundspeed: number; altM: number; climb: number; heading: number; throttle: number }
  | { type: 'GIMBAL_DEVICE_ATTITUDE_STATUS'; q: [number, number, number, number] };

/** CRC_EXTRA and minimum (v1) payload length per supported message id. */
export const MAV_MESSAGES: Record<number, { name: MavMessage['type']; crcExtra: number; len: number }> = {
  0: { name: 'HEARTBEAT', crcExtra: 50, len: 9 },
  1: { name: 'SYS_STATUS', crcExtra: 124, len: 31 },
  30: { name: 'ATTITUDE', crcExtra: 39, len: 28 },
  33: { name: 'GLOBAL_POSITION_INT', crcExtra: 104, len: 28 },
  74: { name: 'VFR_HUD', crcExtra: 20, len: 20 },
  285: { name: 'GIMBAL_DEVICE_ATTITUDE_STATUS', crcExtra: 137, len: 40 },
};

/** CRC-16/MCRF4XX (the "X.25" accumulate used by MAVLink). */
export function crcAccumulate(byte: number, crc: number): number {
  let tmp = (byte ^ (crc & 0xff)) & 0xff;
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

export function mavCrc(bytes: Uint8Array, extra: number): number {
  let crc = 0xffff;
  for (const b of bytes) crc = crcAccumulate(b, crc);
  return crcAccumulate(extra, crc);
}

export interface MavStats {
  frames: number;
  crcErrors: number;
  unknown: number;
  bytesSkipped: number;
}

/** Streaming parser: feed arbitrary chunks (UDP datagrams, TCP or serial reads); complete frames are emitted. */
export class MavParser {
  private buf = Buffer.alloc(0);
  readonly stats: MavStats = { frames: 0, crcErrors: 0, unknown: 0, bytesSkipped: 0 };

  push(chunk: Uint8Array): MavFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: MavFrame[] = [];
    let i = 0;
    while (i < this.buf.length) {
      const magic = this.buf[i];
      if (magic !== 0xfe && magic !== 0xfd) {
        i++;
        this.stats.bytesSkipped++;
        continue;
      }
      const v2 = magic === 0xfd;
      const hdr = v2 ? 10 : 6;
      if (this.buf.length - i < hdr) break;
      const len = this.buf[i + 1]!;
      const incompat = v2 ? this.buf[i + 2]! : 0;
      if (incompat & ~0x01) {
        // Only the "signed" incompatibility flag is defined: this is not a frame start.
        i++;
        this.stats.bytesSkipped++;
        continue;
      }
      const sigLen = v2 && incompat & 0x01 ? 13 : 0;
      const total = hdr + len + 2 + sigLen;
      if (this.buf.length - i < total) break;
      const msgid = v2 ? this.buf[i + 7]! | (this.buf[i + 8]! << 8) | (this.buf[i + 9]! << 16) : this.buf[i + 5]!;
      const def = MAV_MESSAGES[msgid];
      if (!def) {
        // Cannot verify without CRC_EXTRA: skip the frame as framed, but count it.
        this.stats.unknown++;
        i += total;
        continue;
      }
      const crcGiven = this.buf[i + hdr + len]! | (this.buf[i + hdr + len + 1]! << 8);
      const crc = mavCrc(this.buf.subarray(i + 1, i + hdr + len), def.crcExtra);
      if (crc !== crcGiven) {
        // Not a frame (or corrupted): resynchronise from the next byte.
        this.stats.crcErrors++;
        i++;
        continue;
      }
      const payload = Buffer.alloc(Math.max(len, def.len));
      this.buf.copy(payload, 0, i + hdr, i + hdr + len); // v2 truncates trailing zeros; zero-fill restores them
      out.push({ version: v2 ? 2 : 1, seq: this.buf[i + (v2 ? 4 : 2)]!, sysid: this.buf[i + (v2 ? 5 : 3)]!, compid: this.buf[i + (v2 ? 6 : 4)]!, msgid, payload, signed: sigLen > 0 });
      this.stats.frames++;
      i += total;
    }
    this.buf = this.buf.subarray(i);
    if (this.buf.length > 4096) this.buf = this.buf.subarray(this.buf.length - 512);
    return out;
  }
}

const deg = 180 / Math.PI;

export function decodeMav(f: MavFrame): MavMessage | null {
  const p = f.payload;
  switch (f.msgid) {
    case 0:
      return { type: 'HEARTBEAT', customMode: p.readUInt32LE(0), mavType: p[4]!, autopilot: p[5]!, baseMode: p[6]!, systemStatus: p[7]! };
    case 1:
      return { type: 'SYS_STATUS', voltageMv: p.readUInt16LE(14), currentCa: p.readInt16LE(16), batteryRemaining: p.readInt8(30), dropRateComm: p.readUInt16LE(18) };
    case 30:
      return { type: 'ATTITUDE', timeBootMs: p.readUInt32LE(0), roll: p.readFloatLE(4) * deg, pitch: p.readFloatLE(8) * deg, yaw: p.readFloatLE(12) * deg };
    case 33: {
      const hdg = p.readUInt16LE(26);
      return {
        type: 'GLOBAL_POSITION_INT',
        timeBootMs: p.readUInt32LE(0),
        lat: p.readInt32LE(4) / 1e7,
        lon: p.readInt32LE(8) / 1e7,
        altM: p.readInt32LE(12) / 1000,
        relAltM: p.readInt32LE(16) / 1000,
        vn: p.readInt16LE(20) / 100,
        ve: p.readInt16LE(22) / 100,
        vd: p.readInt16LE(24) / 100,
        hdgDeg: hdg === 0xffff ? null : hdg / 100,
      };
    }
    case 74:
      return { type: 'VFR_HUD', airspeed: p.readFloatLE(0), groundspeed: p.readFloatLE(4), altM: p.readFloatLE(8), climb: p.readFloatLE(12), heading: p.readInt16LE(16), throttle: p.readUInt16LE(18) };
    case 285:
      return { type: 'GIMBAL_DEVICE_ATTITUDE_STATUS', q: [p.readFloatLE(4), p.readFloatLE(8), p.readFloatLE(12), p.readFloatLE(16)] };
    default:
      return null;
  }
}

/** Build a frame (used by tests and the replay tool; never sent to a vehicle by this package). */
export function encodeMav(version: 1 | 2, seq: number, sysid: number, compid: number, msgid: number, payload: Buffer): Buffer {
  const def = MAV_MESSAGES[msgid];
  if (!def) throw new Error(`unsupported msgid ${msgid}`);
  let pl = payload;
  if (version === 2) {
    let n = pl.length;
    while (n > 1 && pl[n - 1] === 0) n--;
    pl = pl.subarray(0, n);
  }
  const hdr = version === 2 ? Buffer.from([0xfd, pl.length, 0, 0, seq & 0xff, sysid, compid, msgid & 0xff, (msgid >> 8) & 0xff, (msgid >> 16) & 0xff]) : Buffer.from([0xfe, pl.length, seq & 0xff, sysid, compid, msgid]);
  const body = Buffer.concat([hdr, pl]);
  const crc = mavCrc(body.subarray(1), def.crcExtra);
  return Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]);
}

export type FlightMode = 'docked' | 'patrol' | 'transit' | 'loiter' | 'survey' | 'rtb';

/** Map autopilot-specific modes to the platform's coarse UAS mode. Unknown modes report "transit". */
export function flightMode(hb: Extract<MavMessage, { type: 'HEARTBEAT' }>): FlightMode {
  const armed = (hb.baseMode & 0x80) !== 0;
  if (!armed) return 'docked';
  if (hb.autopilot === 3) {
    // ArduPilot (copter numbering; plane/rover share RTL/LOITER/AUTO semantics closely enough here).
    const m = hb.customMode;
    if (m === 6 || m === 21 || m === 11) return 'rtb';
    if (m === 5 || m === 16 || m === 12) return 'loiter';
    if (m === 3) return 'patrol';
    return 'transit';
  }
  if (hb.autopilot === 12) {
    // PX4: main mode in byte 2, sub mode in byte 3 of custom_mode.
    const main = (hb.customMode >> 16) & 0xff;
    const sub = (hb.customMode >> 24) & 0xff;
    if (main === 4) {
      if (sub === 5 || sub === 6) return 'rtb';
      if (sub === 3) return 'loiter';
      if (sub === 4) return 'patrol';
    }
    return 'transit';
  }
  return 'transit';
}

/** Link quality from sequence-number gaps over a sliding window of received frames. */
export class LinkQuality {
  private last = new Map<string, number>();
  private window: number[] = [];

  frame(f: MavFrame): void {
    const key = `${f.sysid}:${f.compid}`;
    const prev = this.last.get(key);
    this.last.set(key, f.seq);
    if (prev === undefined) return;
    const lost = (f.seq - prev - 1 + 256) % 256;
    // A large jump is a reboot/reconnect, not 200 lost frames.
    this.window.push(lost > 64 ? 0 : lost);
    if (this.window.length > 200) this.window.shift();
  }

  get value(): number {
    if (!this.window.length) return 1;
    const lost = this.window.reduce((a, b) => a + b, 0);
    return Math.round((this.window.length / (this.window.length + lost)) * 1000) / 1000;
  }
}
