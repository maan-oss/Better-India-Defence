import { EnuFrame, FACILITY, INGEST_SCHEMA_VERSION, type IngestEnvelope, type Vec3, hashString } from '@strata/domain';

export const frame = new EnuFrame(FACILITY.origin);

export const toGeo = (p: Vec3) => {
  const g = frame.toGeodetic(p);
  return { lat: round(g.lat, 9), lon: round(g.lon, 9), alt: round(g.alt, 3) };
};

export const round = (v: number, dp: number): number => {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
};

export const sensorHash = (id: string): number => hashString(id) % 100_000;

/**
 * Builds wire envelopes. Sequence numbers are derived from time so that a sensor's sequence is monotonic
 * and identical whether produced by a recorded or live run (seq = observation time in deciseconds + sub-index).
 */
export function envelope<K extends IngestEnvelope['kind']>(
  kind: K,
  sensorId: string,
  adapter: string,
  t: number,
  payload: Extract<IngestEnvelope, { kind: K }>['payload'],
  sub = 0,
): Extract<IngestEnvelope, { kind: K }> {
  const seq = Math.floor(t / 100) * 16 + sub;
  return {
    schema: INGEST_SCHEMA_VERSION,
    messageId: `${sensorId}-${kind}-${t}-${sub}`,
    sensorId,
    adapter,
    seq,
    observedAt: t,
    sentAt: t,
    kind,
    payload,
  } as Extract<IngestEnvelope, { kind: K }>;
}
