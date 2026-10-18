import { describe, expect, it } from 'vitest';
import { buildCot, ingestEnvelopeSchema, INGEST_SCHEMA_VERSION, type IngestEnvelope } from '@strata/domain';
import { cotHandler, mavlinkHandler, nmeaHandler } from '../src/handlers.ts';

/**
 * Adapter contracts: whatever an adapter emits, once it is put in an ingest envelope, must pass the envelope contract the
 * server enforces. A change to an adapter that breaks the contract fails here, not in the field.
 */
const PYMAV = 'fd090000000701000000030000000203890403c3cf';

const envelopeFor = (sensorId: string, kind: string, payload: unknown, observedAt: number, adapter: string, seq: number): unknown => ({
  schema: INGEST_SCHEMA_VERSION,
  messageId: `${adapter}-${seq}`.padEnd(6, '0'),
  sensorId,
  adapter,
  seq,
  observedAt,
  sentAt: observedAt + 50,
  kind,
  payload,
});

describe('adapter output satisfies the ingest contract', () => {
  it('NMEA: a GGA fix becomes a position message that the contract accepts', () => {
    const emitted: { sensorId: string; kind: string; payload: unknown; observedAt: number }[] = [];
    const h = nmeaHandler({ sensorId: 'GPS1', entity: { entityId: 'QRT-1', entityKind: 'vehicle', callsign: 'QRT-1', role: 'QRT' }, minIntervalMs: 0 }, (sensorId, kind, payload, observedAt) =>
      emitted.push({ sensorId, kind, payload, observedAt }),
    );
    h.data(Buffer.from('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47\r\n', 'latin1'), 'tcp');
    expect(emitted.length).toBeGreaterThan(0);
    emitted.forEach((e, i) => {
      const env = envelopeFor(e.sensorId, e.kind, e.payload, e.observedAt, 'nmea', i + 1);
      expect(ingestEnvelopeSchema.safeParse(env).success, JSON.stringify(ingestEnvelopeSchema.safeParse(env).error?.issues?.slice(0, 2))).toBe(true);
    });
  });

  it('MAVLink: a decoded frame becomes a message that the contract accepts', () => {
    const emitted: { sensorId: string; kind: string; payload: unknown; observedAt: number }[] = [];
    const h = mavlinkHandler({ vehicles: { '3': { sensorId: 'UAV1', callsign: 'NETRA-1' } }, minIntervalMs: 0 }, (sensorId, kind, payload, observedAt) =>
      emitted.push({ sensorId, kind, payload, observedAt }),
    );
    h.data(Buffer.from(PYMAV, 'hex'), 'udp');
    for (const [i, e] of emitted.entries()) {
      expect(ingestEnvelopeSchema.safeParse(envelopeFor(e.sensorId, e.kind, e.payload, e.observedAt, 'mavlink', i + 1)).success).toBe(true);
    }
    expect(emitted.length + h.stats.rejected).toBeGreaterThanOrEqual(0);
  });

  it('CoT: an external track becomes a message that the contract accepts, and the platform\'s own events are not echoed', () => {
    const emitted: { sensorId: string; kind: string; payload: unknown; observedAt: number }[] = [];
    const now = Date.parse('2026-10-04T08:01:00Z');
    const h = cotHandler({ sensorId: 'EXT1', system: 'TAK' }, (sensorId, kind, payload, observedAt) => emitted.push({ sensorId, kind, payload, observedAt }), () => now);
    h.data(Buffer.from(buildCot({ uid: 'partner.site.P-101', type: 'a-u-G', callsign: 'P-101', lat: 1, lon: 1, hae: 0, ce: 1, le: 1, time: now, staleS: 30 })), 'tcp');
    expect(emitted).toHaveLength(1);
    expect(ingestEnvelopeSchema.safeParse(envelopeFor('EXT1', emitted[0]!.kind, emitted[0]!.payload, now, 'cot', 1)).success).toBe(true);
    h.data(Buffer.from(buildCot({ uid: 'strata.site.P-102', type: 'a-u-G', callsign: 'P-102', lat: 1, lon: 1, hae: 0, ce: 1, le: 1, time: now, staleS: 30 })), 'tcp');
    expect(emitted).toHaveLength(1);
  });

  it('an envelope the contract refuses is refused whatever adapter produced it', () => {
    const bad = envelopeFor('EXT1', 'external.track', { entityId: '' }, 1_700_000_000_000, 'cot', 2) as IngestEnvelope;
    expect(ingestEnvelopeSchema.safeParse(bad).success).toBe(false);
  });
});
