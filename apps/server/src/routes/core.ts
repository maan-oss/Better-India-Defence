import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getTerrainMode, FACILITY, permissionsFor, ROLE_DESCRIPTIONS, type Role } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { SESSION_COOKIE, audit, isService, parse, requirePerm } from '../http/guards.ts';

/** Auth, ingestion, facility and system routes. */
export function registerCore(app: FastifyInstance, p: Platform): void {
  const cfg = p.cfg;

  app.get('/api/health', async () => ({ ok: true, service: 'strata', time: Date.now(), site: FACILITY.id, simulated: p.simulated, mode: p.cfg.STRATA_MODE, needsSetup: p.needsSetup }));

  // ------------------------------------------------------------------ auth
  app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }), req.body, reply);
    if (!b) return;
    const r = await p.auth.login(b.username, b.password, req.ip);
    if (!r || 'locked' in r) {
      await p.audit.append({ actor: b.username, role: 'none', action: 'login_failed', target: null, detail: { locked: Boolean(r) }, ip: req.ip });
      return reply.code(r ? 429 : 401).send({ error: r ? 'too many failed attempts; try again in a minute' : 'invalid credentials' });
    }
    const secure = Boolean(cfg.TLS_CERT_FILE) || cfg.COOKIE_SECURE === 'true';
    void reply.header('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(r.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${cfg.SESSION_TTL_HOURS * 3600}${secure ? '; Secure' : ''}`);
    await p.audit.append({ actor: r.user.username, role: r.user.role, action: 'login', target: null, detail: {}, ip: req.ip });
    return { user: r.user, permissions: permissionsFor(r.user.role), expiresAt: r.expiresAt, token: r.token };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionToken) await p.auth.logout(req.sessionToken);
    if (req.user) await audit(p, req, 'logout', null);
    void reply.header('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'not signed in', demo: cfg.STRATA_DEMO_USERS === 'true' ? { users: ['viewer', 'operator', 'analyst', 'admin'], password: cfg.NODE_ENV === 'production' ? null : cfg.STRATA_DEMO_PASSWORD } : null });
    return { user: req.user, permissions: permissionsFor(req.user.role) };
  });

  // Pre-sign-in banner: what a terminal shows before authentication (classification, site, use notice).
  app.get('/api/auth/banner', async () => ({
    classification: p.classification,
    site: FACILITY.name,
    simulated: p.simulated,
    notice:
      'This is a government information system for authorised use only. Activity on this system is monitored and recorded, and may be used as evidence. Unauthorised access or use may result in disciplinary and criminal proceedings.',
  }));

  app.get('/api/auth/demo', async () => (cfg.STRATA_DEMO_USERS === 'true' && cfg.NODE_ENV !== 'production' ? { users: ['viewer', 'operator', 'analyst', 'admin'], password: cfg.STRATA_DEMO_PASSWORD } : { users: [], password: null }));

  // ------------------------------------------------------------------ ingestion (service-to-service)
  app.post('/api/ingest/batch', { bodyLimit: 64 * 1024 * 1024, config: { rateLimit: false } }, async (req, reply) => {
    if (!isService(req, cfg.STRATA_SERVICE_TOKEN)) return reply.code(401).send({ error: 'service token required' });
    const body = req.body as { messages?: unknown };
    if (!body || !Array.isArray(body.messages)) return reply.code(400).send({ error: 'expected {messages: [...]}' });
    if (body.messages.length > 5000) return reply.code(413).send({ error: 'batch too large (max 5000)' });
    if (p.ingest.queueDepth > 50_000) return reply.code(503).header('retry-after', '2').send({ error: 'ingestion backlog; retry' });
    const r = await p.ingest.process(body.messages);
    return reply.code(r.rejected.length ? 207 : 202).send(r);
  });

  app.post('/api/ingest/message', { config: { rateLimit: false } }, async (req, reply) => {
    if (!isService(req, cfg.STRATA_SERVICE_TOKEN)) return reply.code(401).send({ error: 'service token required' });
    const r = await p.ingest.process([req.body]);
    return reply.code(r.rejected.length ? 422 : 202).send(r);
  });

  app.post('/api/ingest/media', { bodyLimit: 32 * 1024 * 1024, config: { rateLimit: false } }, async (req, reply) => {
    if (!isService(req, cfg.STRATA_SERVICE_TOKEN)) return reply.code(401).send({ error: 'service token required' });
    const q = parse(
      z.object({ mediaId: z.string().regex(/^[A-Za-z0-9_.-]{4,96}$/), sensorId: z.string().regex(/^[A-Z0-9-]{2,24}$/), kind: z.enum(['pointcloud', 'imagery', 'frame']), capturedAt: z.coerce.number().int().positive(), meta: z.string().max(4000).default('{}') }),
      req.query,
      reply,
    );
    if (!q) return;
    const body = req.body;
    if (!(body instanceof Buffer) || body.length === 0) return reply.code(400).send({ error: 'binary body required' });
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(q.meta) as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ error: 'meta must be JSON' });
    }
    const r = await p.media.ingest({ mediaId: q.mediaId, sensorId: q.sensorId, kind: q.kind, capturedAt: q.capturedAt, contentType: String(req.headers['content-type'] ?? 'application/octet-stream'), meta }, new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });

  app.get('/api/ingest/dead-letters', { preHandler: requirePerm('system.view') }, async () => (await p.db.query('SELECT id, received_at, reason, sensor_id, message_id, left(raw, 400) AS raw FROM dead_letters ORDER BY id DESC LIMIT 200')).rows);

  // ------------------------------------------------------------------ facility
  app.get('/api/facility', { preHandler: requirePerm('world.view') }, async () => ({
    facility: FACILITY,
    liveEdge: p.liveEdge(),
    range: await p.replay.range(),
    terrain: getTerrainMode(),
    simulated: p.simulated,
    orthophoto: p.site?.orthophoto ? { bounds: p.site.orthophoto.bounds, url: '/api/site/orthophoto' } : null,
    basemap: p.site?.basemap ?? null,
    mode: p.cfg.STRATA_MODE,
  }));
  app.get('/api/world/patches', { preHandler: requirePerm('world.view') }, async () => ({ patches: p.coverage.patchList }));

  // ------------------------------------------------------------------ system
  app.get('/api/system/health', { preHandler: requirePerm('system.view') }, async () => {
    const dbStart = performance.now();
    const counts = (await p.db.query<{ obs: number; tracks: number; states: number; media: number; changes: number; dead: number; alerts: number }>(
      `SELECT (SELECT count(*)::int FROM observations) AS obs, (SELECT count(*)::int FROM tracks) AS tracks, (SELECT count(*)::int FROM track_states) AS states,
              (SELECT count(*)::int FROM media_assets) AS media, (SELECT count(*)::int FROM world_changes) AS changes, (SELECT count(*)::int FROM dead_letters) AS dead,
              (SELECT count(*)::int FROM alerts) AS alerts`,
    )).rows[0]!;
    const dbMs = Math.round(performance.now() - dbStart);
    const mediaBytes = (await p.db.query<{ b: number | null }>('SELECT sum(bytes)::bigint AS b FROM media_assets')).rows[0]?.b ?? 0;
    const vms = await p.media.vmsHealthy();
    const jobs = (await p.db.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM reconstructions GROUP BY status')).rows;
    return {
      services: [
        { name: 'API', status: 'ok', detail: `uptime ${p.metrics.snapshot().uptimeS} s` },
        { name: 'Database', status: 'ok', detail: `${p.db.engine === 'pglite' ? 'embedded PostgreSQL (PGlite)' : 'PostgreSQL'} · query ${dbMs} ms` },
        { name: 'Ingestion pipeline', status: p.ingest.queueDepth > 10_000 ? 'degraded' : 'ok', detail: `queue ${p.ingest.queueDepth}` },
        { name: 'Fusion engine', status: 'ok', detail: `${p.fusion.engine.size} tracks in working set` },
        { name: 'Reconstruction workers', status: 'ok', detail: `${p.pool.busy} busy, ${p.pool.queued} queued` },
        { name: 'Video management (VMS adapter)', status: vms ? 'ok' : 'offline', detail: vms ? cfg.SIM_URL : 'unreachable — recorded frames unavailable' },
        { name: 'Copilot provider', status: 'ok', detail: p.copilot.providerStatus.mode },
        { name: 'Live hub', status: 'ok', detail: `${p.hub.size} WebSocket client(s)` },
      ],
      metrics: p.metrics.snapshot(),
      storage: { engine: p.db.engine, counts, mediaBytes, encryptedAtRest: Boolean(cfg.STORAGE_ENCRYPTION_KEY) },
      jobs,
      clock: { dataClock: p.ingest.dataClock, liveEdge: p.liveEdge(), serverTime: Date.now() },
      sensors: p.sensors.all(),
    };
  });

  app.get('/metrics', async (req, reply) => {
    if (!req.user && !isService(req, cfg.STRATA_SERVICE_TOKEN)) return reply.code(401).send('unauthorized');
    const m = p.metrics.snapshot();
    const lines = [
      `strata_ingest_per_second ${m.ingestPerSecond}`,
      `strata_ingest_latency_p95_ms ${m.ingestLatencyMs.p95}`,
      `strata_batch_process_p95_ms ${m.batchProcessMs.p95}`,
      `strata_event_loop_lag_p99_ms ${m.eventLoopLagMs.p99}`,
      `strata_ws_clients ${p.hub.size}`,
      ...Object.entries(m.counters).map(([k, v]) => `strata_${k}_total ${v}`),
    ];
    return reply.type('text/plain').send(`${lines.join('\n')}\n`);
  });

  // ------------------------------------------------------------------ audit
  app.get('/api/audit', { preHandler: requirePerm('audit.view') }, async (req, reply) => {
    const q = parse(z.object({ q: z.string().max(100).optional(), action: z.string().max(64).optional(), actor: z.string().max(64).optional(), before: z.coerce.number().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query, reply);
    if (!q) return;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.action) {
      params.push(q.action);
      where.push(`action = $${params.length}`);
    }
    if (q.actor) {
      params.push(q.actor);
      where.push(`actor = $${params.length}`);
    }
    if (q.before) {
      params.push(q.before);
      where.push(`seq < $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(target ILIKE $${params.length} OR detail::text ILIKE $${params.length} OR action ILIKE $${params.length})`);
    }
    params.push(q.limit);
    return (await p.db.query(`SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT $${params.length}`, params)).rows;
  });
  app.get('/api/audit/verify', { preHandler: requirePerm('audit.view') }, async () => p.audit.verify());

  // ------------------------------------------------------------------ admin
  app.get('/api/admin/users', { preHandler: requirePerm('admin.users') }, async () => p.auth.list());
  app.get('/api/admin/roles', { preHandler: requirePerm('world.view') }, async () => (['viewer', 'operator', 'analyst', 'administrator'] as Role[]).map((r) => ({ role: r, description: ROLE_DESCRIPTIONS[r], permissions: permissionsFor(r) })));
  app.post('/api/admin/users', { preHandler: requirePerm('admin.users') }, async (req, reply) => {
    const b = parse(z.object({ username: z.string().regex(/^[a-z0-9._-]{3,32}$/), displayName: z.string().min(1).max(64), role: z.enum(['viewer', 'operator', 'analyst', 'administrator']), password: z.string().min(12).max(256) }), req.body, reply);
    if (!b) return;
    try {
      const u = await p.auth.create(b.username, b.displayName, b.role, b.password);
      await audit(p, req, 'user_created', u.username, { role: u.role });
      return reply.code(201).send(u);
    } catch {
      return reply.code(409).send({ error: 'username already exists' });
    }
  });
  app.patch('/api/admin/users/:id', { preHandler: requirePerm('admin.users') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ role: z.enum(['viewer', 'operator', 'analyst', 'administrator']).optional(), disabled: z.boolean().optional(), displayName: z.string().min(1).max(64).optional(), password: z.string().min(12).max(256).optional() }), req.body, reply);
    if (!b) return;
    if (id === req.user!.id && (b.disabled || (b.role && b.role !== 'administrator'))) return reply.code(400).send({ error: 'you cannot demote or disable your own account' });
    const u = await p.auth.update(id, b);
    if (!u) return reply.code(404).send({ error: 'not found' });
    await audit(p, req, 'user_updated', u.username, { role: b.role, disabled: b.disabled, passwordChanged: Boolean(b.password) });
    return u;
  });
  app.get('/api/admin/config', { preHandler: requirePerm('admin.config') }, async () => ({
    mode: p.cfg.STRATA_MODE,
    stored: (await p.db.query('SELECT key, value, updated_by, updated_at FROM config ORDER BY key')).rows,
    effective: {
      database: p.db.engine,
      storageEncryptionAtRest: Boolean(cfg.STORAGE_ENCRYPTION_KEY),
      tls: Boolean(cfg.TLS_CERT_FILE),
      copilot: p.copilot.providerStatus,
      autoIncidents: cfg.AUTO_INCIDENTS === 'true',
      vmsUrl: cfg.SIM_URL,
      sessionTtlHours: cfg.SESSION_TTL_HOURS,
      demoUsers: cfg.STRATA_DEMO_USERS === 'true',
      facilityOrigin: FACILITY.origin,
    },
    integrations: await integrations(p),
  }));
  app.put('/api/admin/config/:key', { preHandler: requirePerm('admin.config') }, async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!/^[a-z0-9._-]{2,64}$/.test(key)) return reply.code(400).send({ error: 'invalid key' });
    const body = req.body as { value?: unknown };
    if (body?.value === undefined) return reply.code(400).send({ error: 'value required' });
    await p.db.query('INSERT INTO config (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,$4) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at', [key, JSON.stringify(body.value), req.user!.username, Date.now()]);
    await audit(p, req, 'config_changed', key, { value: body.value });
    return { ok: true };
  });
}

/**
 * What is actually connected. The simulated demo reports its simulated sources as such; an operational site reports
 * its configured cameras and feeds with their live state, and the optional language-model provider.
 */
async function integrations(p: Platform): Promise<{ name: string; adapter: string; status: string }[]> {
  const llm = { name: 'Language model provider', adapter: 'anthropic', status: p.copilot.providerStatus.configured ? `configured (${p.copilot.providerStatus.model})` : 'not configured — deterministic copilot only' };
  if (p.simulated)
    return [
      { name: 'Video management system', adapter: 'vms.onvif-analytics-bridge.v1 (synthetic VMS)', status: 'connected (simulated)' },
      { name: 'Surveillance radar', adapter: 'radar.generic-asterix-bridge.v1', status: 'simulated source — real ASTERIX CAT-048/062 decoder not included' },
      { name: 'Passive RF', adapter: 'rf.passive-df.v1', status: 'simulated source' },
      { name: 'Satellite imagery provider', adapter: 'eo.provider-delivery.v1', status: 'simulated deliveries — no commercial provider contract' },
      llm,
    ];
  const now = Date.now();
  const status = await p.replay.sensorStatusAt(now).catch(() => ({}) as Record<string, { status: string; lastSeen: number | null }>);
  const seen = (id: string) => {
    const s = status[id];
    if (!s?.lastSeen) return 'configured — no data received yet';
    const age = Math.round((now - s.lastSeen) / 1000);
    return `${s.status} — last data ${age < 120 ? `${age} s` : `${Math.round(age / 60)} min`} ago`;
  };
  const cams = await p.cameras.list();
  const out = cams.map((c) => ({
    name: `Camera ${c.id} · ${c.name}`,
    adapter: c.scheme === 'device' ? 'browser device camera' : `${c.scheme} stream${p.vision.ffmpeg ? '' : ' (ffmpeg not installed)'}`,
    status: c.enabled ? `${c.status.state}${c.status.lastError ? ` — ${c.status.lastError}` : ''}` : 'disabled',
  }));
  for (const s of FACILITY.sensors) {
    if (s.kind === 'gps') out.push({ name: s.name, adapter: 'gps.position (NMEA / AVL / field devices)', status: seen(s.id) });
    else if (s.kind === 'external') out.push({ name: s.name, adapter: `track feed (${s.system})`, status: seen(s.id) });
    else if (s.kind === 'drone') out.push({ name: s.name, adapter: 'MAVLink telemetry', status: seen(s.id) });
  }
  if (!out.length) out.push({ name: 'Sensors', adapter: '—', status: 'none connected — add cameras on the camera wall and feeds in Site setup' });
  out.push(llm);
  return out;
}
