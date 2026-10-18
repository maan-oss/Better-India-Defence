import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS, contractDocuments, ingestEnvelopeSchema, AssetInput, INGEST_SCHEMA_VERSION } from '../src/index.ts';

/** The published JSON Schema documents must be the ones the code generates, and the contracts must enforce what they say. */
const here = dirname(fileURLToPath(import.meta.url));
const schemaFile = (name: string) => join(here, '..', '..', '..', 'docs', 'schemas', `${name}.schema.json`);

describe('integration contracts', () => {
  it('the committed schema documents equal what the zod contracts generate (run `npm run schemas` after a change)', () => {
    const generated = contractDocuments();
    for (const name of Object.keys(CONTRACTS) as (keyof typeof CONTRACTS)[]) {
      const committed = JSON.parse(readFileSync(schemaFile(name), 'utf8'));
      expect(committed, name).toEqual(generated[name]);
    }
  });

  it('every document names its draft and identifier', () => {
    for (const doc of Object.values(contractDocuments())) {
      expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(String(doc.$id)).toMatch(/^https:\/\/strata\.local\/schemas\/.+\.schema\.json$/);
    }
  });

  it('the envelope contract accepts a valid message and refuses an unknown kind, a bad sensor id and a missing schema version', () => {
    const base = { schema: INGEST_SCHEMA_VERSION, messageId: 'msg-000001', sensorId: 'GPS1', adapter: 'nmea', seq: 1, observedAt: 1_700_000_000_000, sentAt: 1_700_000_000_100 };
    const position = { entityId: 'QRT-1', entityKind: 'vehicle', callsign: 'QRT-1', role: 'QRT', status: 'available', position: { lat: 48.1, lon: 11.5, alt: 545 }, accuracyM: 4 };
    expect(ingestEnvelopeSchema.safeParse({ ...base, kind: 'gps.position', payload: position }).success).toBe(true);
    // The payload must match the kind's own contract: a position that is out of range is refused.
    expect(ingestEnvelopeSchema.safeParse({ ...base, kind: 'gps.position', payload: { ...position, position: { lat: 123, lon: 11.5, alt: 545 } } }).success).toBe(false);
    expect(ingestEnvelopeSchema.safeParse({ ...base, kind: 'not.a.kind', payload: {} }).success).toBe(false);
    expect(ingestEnvelopeSchema.safeParse({ ...base, sensorId: 'gps one', kind: 'sensor.health', payload: {} }).success).toBe(false);
    expect(ingestEnvelopeSchema.safeParse({ ...base, schema: undefined, kind: 'sensor.health', payload: {} }).success).toBe(false);
  });

  it('the asset contract enforces the same limits the register enforces', () => {
    expect(AssetInput.safeParse({ tag: 'ups-1', name: 'x', category: 'power', criticality: 3 }).success).toBe(false);
    expect(AssetInput.safeParse({ tag: 'UPS-1', name: 'UPS', category: 'power', criticality: 3, classification: 'SECRET', owner: 'logistics' }).success).toBe(true);
  });
});
