#!/usr/bin/env node
/**
 * strata-adapter — runs field adapters described in a JSON config and posts to the Strata ingest API.
 *
 *   strata-adapter adapters.json
 *
 * Environment: STRATA_INGEST_URL (default http://127.0.0.1:4000), STRATA_SERVICE_TOKEN (required).
 * See docs/INTEROP.md and packages/adapters/adapters.example.json.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { IngestClient } from './client.ts';
import { cotHandler, mavlinkHandler, nmeaHandler, type Handler } from './handlers.ts';
import { sender, startTransport, type Running } from './transports.ts';

const transport = z.discriminatedUnion('type', [
  z.object({ type: z.literal('udp'), port: z.number().int().min(1).max(65535), bind: z.string().optional(), multicast: z.string().optional(), multicastInterface: z.string().optional() }),
  z.object({ type: z.literal('tcp-client'), host: z.string(), port: z.number().int().min(1).max(65535) }),
  z.object({ type: z.literal('tcp-server'), port: z.number().int().min(1).max(65535), bind: z.string().optional() }),
  z.object({ type: z.literal('file'), path: z.string(), bytesPerSecond: z.number().positive().optional() }),
]);
const entity = z.object({ entityId: z.string().min(1).max(32), entityKind: z.enum(['person', 'vehicle']), callsign: z.string().max(48), role: z.string().max(48) });
const sensorId = z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/);

const ConfigSchema = z.object({
  ingestUrl: z.string().url().optional(),
  listeners: z
    .array(
      z.discriminatedUnion('protocol', [
        z.object({ protocol: z.literal('nmea'), name: z.string().optional(), transport, sensorId, entity: entity.optional(), entities: z.record(z.string(), entity).optional(), requireChecksum: z.boolean().optional(), minIntervalMs: z.number().int().min(0).optional() }),
        z.object({
          protocol: z.literal('mavlink'),
          name: z.string().optional(),
          transport,
          vehicles: z.record(z.string().regex(/^\d{1,3}$/), z.object({ sensorId, callsign: z.string().max(32), hfovDeg: z.number().positive().max(179).optional(), gimbalPitchDeg: z.number().min(-90).max(90).optional() })),
          minIntervalMs: z.number().int().min(0).optional(),
        }),
        z.object({ protocol: z.literal('cot'), name: z.string().optional(), transport, sensorId, system: z.string().max(32).optional(), ignoreUidPrefixes: z.array(z.string()).optional(), affiliations: z.array(z.string()).optional() }),
      ]),
    )
    .default([]),
  /** Publish the platform's track picture as CoT (for ATAK/WinTAK/C2 consumers). */
  cotOut: z
    .object({
      intervalS: z.number().min(1).max(600).default(5),
      targets: z.array(z.object({ type: z.enum(['udp', 'tcp']), host: z.string(), port: z.number().int().min(1).max(65535) })).min(1),
      /** Include tracks of these categories (default all). */
      categories: z.array(z.enum(['aerial', 'person', 'vehicle', 'unknown'])).optional(),
    })
    .optional(),
});
export type AdapterConfig = z.infer<typeof ConfigSchema>;

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: strata-adapter <config.json>');
    process.exit(2);
  }
  const cfg = ConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const url = (cfg.ingestUrl ?? process.env.STRATA_INGEST_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
  const token = process.env.STRATA_SERVICE_TOKEN;
  if (!token) {
    console.error('STRATA_SERVICE_TOKEN is required');
    process.exit(2);
  }
  const client = new IngestClient(url, token, 'strata-adapter.v1', { log });
  const emit = client.send.bind(client);
  const running: { name: string; handler: Handler; t: Running }[] = [];
  for (const l of cfg.listeners) {
    const handler = l.protocol === 'nmea' ? nmeaHandler(l, emit) : l.protocol === 'mavlink' ? mavlinkHandler(l, emit) : cotHandler(l, emit);
    const t = startTransport(l.transport, (d, peer) => handler.data(d, peer), log);
    const name = l.name ?? `${l.protocol}`;
    running.push({ name, handler, t });
    log(`${name}: ${l.protocol} on ${t.describe}`);
  }

  let cotTimer: NodeJS.Timeout | null = null;
  if (cfg.cotOut) {
    const out = cfg.cotOut;
    const senders = out.targets.map((t) => sender(t, log));
    const q = out.categories ? `?categories=${out.categories.join(',')}` : '';
    const tick = async () => {
      try {
        const r = await fetch(`${url}/api/interop/cot${q}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { events } = (await r.json()) as { events: string[] };
        for (const e of events) for (const s of senders) s.send(e);
      } catch (e) {
        log(`cot out: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    cotTimer = setInterval(() => void tick(), out.intervalS * 1000);
    log(`cot out: every ${out.intervalS} s to ${out.targets.map((t) => `${t.type}://${t.host}:${t.port}`).join(', ')}`);
  }

  const status = setInterval(() => {
    const parts = running.map((r) => `${r.name} rx=${r.handler.stats.received} tx=${r.handler.stats.emitted} rej=${r.handler.stats.rejected}${r.handler.stats.lastReason ? ` (${r.handler.stats.lastReason})` : ''}`);
    log(`${parts.join(' | ')} | ingest sent=${client.stats.sent} queued=${client.queued} rejected=${client.stats.rejected} dropped=${client.stats.dropped}`);
  }, 60_000);

  const stop = async () => {
    clearInterval(status);
    if (cotTimer) clearInterval(cotTimer);
    for (const r of running) await r.t.close();
    await client.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

void main();
