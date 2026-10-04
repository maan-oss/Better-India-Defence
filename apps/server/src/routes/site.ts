import type { FastifyInstance } from 'fastify';
import { FACILITY, SiteConfigSchema, demoAsSiteConfig } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { audit, parse, requirePerm } from '../http/guards.ts';
import { decodeImage, encodeJpeg } from '../vision/imageio.ts';
import { resizeRgb } from '@strata/domain/vision';

/**
 * Site configuration (administrator). The site model is applied at start-up so every service sees one
 * consistent geometry and georeference; saving therefore takes effect after a restart of the service.
 */
export function registerSite(app: FastifyInstance, p: Platform): void {
  app.get('/api/site', { preHandler: requirePerm('admin.config') }, async () => {
    const stored = (await p.db.query<{ value: unknown; updated_by: string; updated_at: number }>(`SELECT value, updated_by, updated_at FROM config WHERE key = 'site.definition'`)).rows[0];
    return {
      active: { id: FACILITY.id, name: FACILITY.name, origin: FACILITY.origin, simulated: p.site === null },
      stored: stored ? { config: stored.value, updatedBy: stored.updated_by, updatedAt: stored.updated_at } : null,
      template: demoAsSiteConfig(),
      restartRequired: stored ? canon(stored.value) !== canon(p.site) : p.site !== null,
    };
  });

  app.put('/api/site', { preHandler: requirePerm('admin.config') }, async (req, reply) => {
    const b = parse(SiteConfigSchema, req.body, reply);
    if (!b) return;
    if (b.id === 'site-kestrel') return reply.code(400).send({ error: 'choose an id for your site (site-kestrel is the demo)' });
    const ids = new Set<string>();
    for (const z of b.zones) {
      if (ids.has(z.id)) return reply.code(400).send({ error: `duplicate zone id ${z.id}` });
      ids.add(z.id);
    }
    await p.db.query(`INSERT INTO config (key, value, updated_by, updated_at) VALUES ('site.definition', $1::jsonb, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`, [JSON.stringify(b), req.user!.username, Date.now()]);
    await audit(p, req, 'site_definition_saved', b.id, { name: b.name, origin: b.origin, zones: b.zones.length, buildings: b.buildings.length });
    return { ok: true, restartRequired: true };
  });

  app.delete('/api/site', { preHandler: requirePerm('admin.config') }, async (req) => {
    await p.db.query(`DELETE FROM config WHERE key = 'site.definition'`);
    await audit(p, req, 'site_definition_removed', FACILITY.id, {});
    return { ok: true, restartRequired: true };
  });

  /** Orthophoto upload: stored downsampled to ≤ 8192 px (JPEG) for use as ground texture. */
  app.post('/api/site/orthophoto', { preHandler: requirePerm('admin.config'), bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
    if (!(req.body instanceof Buffer)) return reply.code(415).send({ error: 'send the image as image/jpeg, image/png or application/octet-stream' });
    let img;
    try {
      img = decodeImage(new Uint8Array(req.body));
    } catch (e) {
      return reply.code(422).send({ error: e instanceof Error ? e.message : String(e) });
    }
    const k = Math.min(1, 8192 / Math.max(img.width, img.height));
    const out = k < 1 ? resizeRgb(img, Math.round(img.width * k), Math.round(img.height * k)) : img;
    const stored = await p.store.put('site', encodeJpeg(out, 88));
    await audit(p, req, 'site_orthophoto_uploaded', stored.sha256, { width: out.width, height: out.height });
    return { key: stored.key, encrypted: stored.encrypted, width: out.width, height: out.height };
  });

  app.get('/api/site/orthophoto', { preHandler: requirePerm('world.view') }, async (req, reply) => {
    const key = (req.query as { key?: string }).key ?? p.site?.orthophoto?.key;
    if (!key || !/^site\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key)) return reply.code(404).send({ error: 'no orthophoto' });
    const bytes = await p.store.get(key, Boolean(p.cfg.STORAGE_ENCRYPTION_KEY)).catch(() => null);
    if (!bytes) return reply.code(404).send({ error: 'no orthophoto' });
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=86400').send(Buffer.from(bytes));
  });
}

/** JSON with object keys sorted, so a jsonb round trip (which reorders keys) compares equal. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
}
