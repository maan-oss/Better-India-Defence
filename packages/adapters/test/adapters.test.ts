import { describe, expect, it } from 'vitest';
import { createSocket } from 'node:dgram';
import { affiliationOf, buildCot, categoryOf, cotToExternal, CotStreamSplitter, externalTrackPayload, droneTelemetryPayload, gpsPositionPayload, parseCot } from '@strata/domain';
import { decodeMav, encodeMav, flightMode, MavParser, nmeaChecksum, NmeaTracker, parseNmea } from '../src/index.ts';
import { cotHandler, mavlinkHandler, nmeaHandler } from '../src/handlers.ts';
import { IngestClient } from '../src/client.ts';
import { startTransport } from '../src/transports.ts';

describe('NMEA 0183', () => {
  it('parses the reference GGA sentence and verifies its checksum', () => {
    const r = parseNmea('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fix.lat).toBeCloseTo(48 + 7.038 / 60, 9);
    expect(r.fix.lon).toBeCloseTo(11 + 31 / 60, 9);
    expect(r.fix).toMatchObject({ talker: 'GP', sentence: 'GGA', altM: 545.4, quality: 1, satellites: 8, hdop: 0.9, utcSeconds: 12 * 3600 + 35 * 60 + 19 });
  });

  it('rejects a corrupted sentence instead of repairing it', () => {
    const r = parseNmea('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*48');
    expect(r).toMatchObject({ ok: false });
    expect(parseNmea('$GPGGA,123519,4807.038,N,01131.000,E,0,00,,,M,,M,,*' + nmeaChecksum('GPGGA,123519,4807.038,N,01131.000,E,0,00,,,M,,M,,'))).toMatchObject({ ok: false, reason: expect.stringContaining('no fix') });
  });

  it('parses RMC with date, speed and course; southern/western hemispheres; GN talker; unit prefix', () => {
    const body = 'GNRMC,083559.00,A,2833.3720,N,07706.0000,E,10.0,084.4,041026,,,A';
    const r = parseNmea(`V-07,$${body}*${nmeaChecksum(body)}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fix.unit).toBe('V-07');
    expect(r.fix.time).toBe(Date.UTC(2026, 9, 4, 8, 35, 59));
    expect(r.fix.speedMps).toBeCloseTo(5.14444, 4);
    expect(r.fix.courseDeg).toBe(84.4);
    expect(r.fix.lat).toBeCloseTo(28 + 33.372 / 60, 9);
    const sw = 'GPRMC,000000,A,3330.0000,S,15115.0000,W,0,0,010126,,';
    const s = parseNmea(`$${sw}*${nmeaChecksum(sw)}`);
    expect(s.ok && s.fix.lat).toBeCloseTo(-33.5, 9);
    expect(s.ok && s.fix.lon).toBeCloseTo(-151.25, 9);
    const v = 'GPRMC,000000,V,3330.0000,S,15115.0000,W,0,0,010126,,';
    expect(parseNmea(`$${v}*${nmeaChecksum(v)}`)).toMatchObject({ ok: false });
  });

  it('merges GGA altitude/HDOP into RMC reports of the same second', () => {
    const tr = new NmeaTracker();
    const g = 'GPGGA,083559.00,2833.3720,N,07706.0000,E,2,12,0.8,231.0,M,-35.0,M,,';
    const r = 'GPRMC,083559.00,A,2833.3720,N,07706.0000,E,0.0,0.0,041026,,,D';
    const gf = parseNmea(`$${g}*${nmeaChecksum(g)}`);
    const rf = parseNmea(`$${r}*${nmeaChecksum(r)}`);
    if (!gf.ok || !rf.ok) throw new Error('parse');
    tr.push(gf.fix);
    const rep = tr.push(rf.fix)!;
    expect(rep.altM).toBe(231);
    expect(rep.quality).toBe(2);
    expect(rep.accuracyM).toBeCloseTo(1.2, 5); // HDOP 0.8 × 1.5 m (DGPS)
  });
});

/** Frames produced by pymavlink 2.4.50 (common dialect), system id 7. */
const PYMAV: [string, string][] = [
  ['v2', 'fd090000000701000000030000000203890403c3cf'],
  ['v2', 'fd1f0000000701010000010000000100000001000000f401105910fa0000000000000000000043000c8dcd'],
  ['v2', 'fd1000000007011e000040e20100c2b8323d35fa8ebdc34bcb3fd318'],
  ['v2', 'fd1c00000007012100006ce20100f3220e11582a052ed41804004ccc00005e0188ffe7ff8c23c4cd'],
  ['v1', 'fe1c00070121d0e20100404e08ec20eb265ae8030000f4010000000000000000ffff90d9'],
  ['v1', 'fe090007010000000405020c800403d1a8'],
  ['v2', 'fd1300000007014a0000000048410000304100408643cdccccbe5b0037612c'],
];

describe('MAVLink', () => {
  const frames = () => {
    const p = new MavParser();
    // Fed as one noisy stream: leading garbage and split boundaries must not matter.
    const all = Buffer.concat([Buffer.from([0x00, 0x55, 0xfd]), ...PYMAV.map(([, h]) => Buffer.from(h, 'hex'))]);
    const out = [...p.push(all.subarray(0, 37)), ...p.push(all.subarray(37, 90)), ...p.push(all.subarray(90))];
    return { out, p };
  };

  it('decodes v1 and v2 frames produced by pymavlink, verifying CRC with CRC_EXTRA', () => {
    const { out, p } = frames();
    expect(out.map((f) => f.msgid)).toEqual([0, 1, 30, 33, 33, 0, 74]);
    expect(out.every((f) => f.sysid === 7)).toBe(true);
    expect(p.stats.frames).toBe(7);
    const msgs = out.map(decodeMav);
    expect(msgs[0]).toMatchObject({ type: 'HEARTBEAT', customMode: 3, autopilot: 3, baseMode: 0x89 });
    expect(msgs[1]).toMatchObject({ type: 'SYS_STATUS', voltageMv: 22800, currentCa: -1520, batteryRemaining: 12 });
    const att = msgs[2] as Extract<ReturnType<typeof decodeMav>, { type: 'ATTITUDE' }>;
    expect(att.roll).toBeCloseTo(2.5, 4);
    expect(att.pitch).toBeCloseTo(-4, 4);
    expect(att.yaw).toBeCloseTo(91, 4);
    expect(msgs[3]).toMatchObject({ type: 'GLOBAL_POSITION_INT', lat: 28.6139123, lon: 77.2090456, altM: 268.5, relAltM: 52.3, vn: 3.5, ve: -1.2, vd: -0.25, hdgDeg: 91 });
    expect(msgs[4]).toMatchObject({ lat: -33.5, lon: 151.25, hdgDeg: null });
    expect(msgs[6]).toMatchObject({ type: 'VFR_HUD', heading: 91, throttle: 55 });
  });

  it('round-trips through the encoder and rejects a corrupted frame', () => {
    const f = Buffer.from(PYMAV[3]![1], 'hex');
    const p = new MavParser();
    const [orig] = p.push(f);
    expect(encodeMav(2, orig!.seq, orig!.sysid, orig!.compid, 33, orig!.payload).equals(f)).toBe(true);
    const bad = Buffer.from(f);
    bad[15]! ^= 0x40;
    expect(new MavParser().push(bad)).toHaveLength(0);
  });

  it('maps ArduPilot and PX4 modes; disarmed is docked', () => {
    expect(flightMode({ type: 'HEARTBEAT', customMode: 6, mavType: 2, autopilot: 3, baseMode: 0x80, systemStatus: 4 })).toBe('rtb');
    expect(flightMode({ type: 'HEARTBEAT', customMode: 5, mavType: 2, autopilot: 3, baseMode: 0x80, systemStatus: 4 })).toBe('loiter');
    expect(flightMode({ type: 'HEARTBEAT', customMode: (4 << 16) | (5 << 24), mavType: 2, autopilot: 12, baseMode: 0x80, systemStatus: 4 })).toBe('rtb');
    expect(flightMode({ type: 'HEARTBEAT', customMode: 3, mavType: 2, autopilot: 3, baseMode: 0x01, systemStatus: 3 })).toBe('docked');
  });

  it('produces schema-valid drone.telemetry for a mapped vehicle and ignores unmapped ones', () => {
    const sent: { sensorId: string; kind: string; payload: unknown }[] = [];
    const h = mavlinkHandler({ vehicles: { '7': { sensorId: 'UAV1', callsign: 'NETRA-1' } }, minIntervalMs: 0 }, (sensorId, kind, payload) => sent.push({ sensorId, kind, payload }));
    for (const [, hex] of PYMAV) h.data(Buffer.from(hex, 'hex'), 'udp');
    expect(sent).toHaveLength(2);
    const p = droneTelemetryPayload.parse(sent[0]!.payload);
    expect(sent[0]!.sensorId).toBe('UAV1');
    expect(p).toMatchObject({ callsign: 'NETRA-1', mode: 'patrol', batteryPct: 12, velocity: { ve: -1.2, vn: 3.5, vu: 0.25 } });
    expect(p.attitude.headingDeg).toBe(91);
    const other = mavlinkHandler({ vehicles: {} }, () => sent.push({ sensorId: 'x', kind: 'x', payload: null }));
    for (const [, hex] of PYMAV) other.data(Buffer.from(hex, 'hex'), 'udp');
    expect(sent).toHaveLength(2);
    expect(other.stats.lastReason).toMatch(/unmapped/);
  });
});

describe('Cursor-on-Target', () => {
  const sample = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0" uid="ANDROID-abc123" type="a-h-G-E-V-A" how="h-e" time="2026-10-04T08:00:00.000Z" start="2026-10-04T08:00:00.000Z" stale="2026-10-04T08:05:00.000Z">
  <point lat="28.556200" lon="77.100000" hae="9999999.0" ce="35.0" le="9999999.0"/>
  <detail><contact callsign="Tgt &amp; 1"/><track course="270.0" speed="4.5"/><remarks>Seen near &lt;gate 2&gt;</remarks></detail>
</event>`;

  it('parses an event, treating 9999999 as unknown', () => {
    const r = parseCot(sample);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).toMatchObject({ uid: 'ANDROID-abc123', type: 'a-h-G-E-V-A', how: 'h-e', lat: 28.5562, lon: 77.1, hae: null, ce: 35, callsign: 'Tgt & 1', courseDeg: 270, speedMps: 4.5, remarks: 'Seen near <gate 2>' });
    expect(r.event.time).toBe(Date.parse('2026-10-04T08:00:00Z'));
    const ext = externalTrackPayload.parse(cotToExternal(r.event, 'TAK'));
    expect(ext).toMatchObject({ affiliation: 'hostile', category: 'vehicle', ceM: 35, system: 'TAK' });
  });

  it('maps MIL-STD-2525 affiliations and battle dimensions', () => {
    expect(['a-f-G', 'a-a-G', 'a-h-G', 'a-s-G', 'a-n-G', 'a-u-G', 'a-p-G', 'a-j-G'].map(affiliationOf)).toEqual(['friend', 'friend', 'hostile', 'suspect', 'neutral', 'unknown', 'pending', 'hostile']);
    expect(categoryOf('a-h-A-M-F-Q')).toBe('drone');
    expect(categoryOf('a-h-A-M-F')).toBe('aircraft');
    expect(categoryOf('a-f-G-U-C-I')).toBe('person');
    expect(categoryOf('a-u-G-E-V')).toBe('vehicle');
    expect(categoryOf('a-n-S')).toBe('vessel');
    expect(categoryOf('a-u-G')).toBe('unknown');
  });

  it('refuses DTDs (no entity expansion) and non-track types', () => {
    expect(parseCot('<!DOCTYPE x [<!ENTITY a "aaaa">]>' + sample)).toMatchObject({ ok: false });
    const r = parseCot(sample.replace('a-h-G-E-V-A', 'b-m-p-s-p-i'));
    expect(r.ok && cotToExternal(r.event)).toBe(null);
  });

  it('round-trips built events and splits a TCP stream', () => {
    const xml = buildCot({ uid: 'strata.x.V-101', type: 'a-f-G-E-V', callsign: 'QRT "1"', lat: 28.1, lon: 77.2, hae: 230, ce: 3, le: 5, time: Date.parse('2026-10-04T08:00:00Z'), staleS: 30, courseDeg: 45, speedMps: 8 });
    const sp = new CotStreamSplitter();
    const docs = [...sp.push(xml.slice(0, 100)), ...sp.push(xml.slice(100) + sample.slice(0, 50)), ...sp.push(sample.slice(50))];
    expect(docs).toHaveLength(2);
    const a = parseCot(docs[0]!);
    expect(a.ok && a.event).toMatchObject({ callsign: 'QRT "1"', courseDeg: 45, speedMps: 8, stale: Date.parse('2026-10-04T08:00:30Z') });
  });

  it('handler ignores this platform’s own events (no echo) and emits external.track', () => {
    const sent: unknown[] = [];
    const h = cotHandler({ sensorId: 'EXT1', system: 'TAK' }, (_s, _k, p) => sent.push(p), () => Date.parse('2026-10-04T08:01:00Z'));
    h.data(Buffer.from(buildCot({ uid: 'strata.site.P-101', type: 'a-u-G', callsign: 'P-101', lat: 1, lon: 1, hae: 0, ce: 1, le: 1, time: Date.now(), staleS: 30 }) + sample), 'tcp');
    expect(sent).toHaveLength(1);
    expect(externalTrackPayload.safeParse(sent[0]).success).toBe(true);
  });
});

describe('adapter runtime', () => {
  it('receives NMEA over UDP and posts schema-valid gps.position batches with retry', async () => {
    const posted: unknown[][] = [];
    let fail = 1;
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      if (fail-- > 0) return new Response('busy', { status: 503 });
      posted.push((JSON.parse(init.body) as { messages: unknown[] }).messages);
      return new Response(JSON.stringify({ accepted: posted.at(-1)!.length, rejected: [] }), { status: 202 });
    }) as unknown as typeof fetch;
    const client = new IngestClient('http://ingest', 'token-0123456789abcdef', 'test.v1', { flushMs: 20, fetchImpl: fakeFetch });
    const h = nmeaHandler({ sensorId: 'GPS1', entities: { 'V-07': { entityId: 'QRT-1', entityKind: 'vehicle', callsign: 'QRT-1', role: 'QRT' } }, minIntervalMs: 0 }, client.send.bind(client));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const t = startTransport({ type: 'udp', port, bind: '127.0.0.1' }, (d, peer) => h.data(d, peer), () => {});
    await new Promise((r) => setTimeout(r, 100));
    const s = createSocket('udp4');
    const body = 'GPRMC,083559.00,A,2833.3720,N,07706.0000,E,10.0,084.4,041025,,,A';
    await new Promise<void>((r) => s.send(`V-07,$${body}*${nmeaChecksum(body)}\r\nUNKNOWN,$${body}*${nmeaChecksum(body)}\r\n`, port, '127.0.0.1', () => r()));
    for (let i = 0; i < 60 && !posted.length; i++) await new Promise((r) => setTimeout(r, 50));
    s.close();
    await t.close();
    client.stop();
    expect(client.stats.failures).toBe(1);
    expect(posted).toHaveLength(1);
    const msg = posted[0]![0] as { sensorId: string; kind: string; payload: unknown; observedAt: number };
    expect(msg).toMatchObject({ sensorId: 'GPS1', kind: 'gps.position', observedAt: Date.UTC(2025, 9, 4, 8, 35, 59) });
    expect(gpsPositionPayload.parse(msg.payload)).toMatchObject({ entityId: 'QRT-1', headingDeg: 84.4 });
    expect(h.stats).toMatchObject({ received: 2, emitted: 1, rejected: 1 });
  });
});
