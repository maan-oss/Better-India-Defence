import Fastify, { LogController, type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import type { Platform } from './platform.ts';
import { SESSION_COOKIE, bearer, readCookie } from './http/guards.ts';
import { registerCore } from './routes/core.ts';
import { registerOperations } from './routes/operations.ts';
import { registerVision } from './routes/vision.ts';
import { registerCameras } from './routes/cameras.ts';
import { registerOps } from './routes/ops.ts';
import { registerSite } from './routes/site.ts';
import { registerInterop } from './routes/interop.ts';

export async function buildApp(p: Platform): Promise<FastifyInstance> {
  const cfg = p.cfg;
  const https = cfg.TLS_CERT_FILE && cfg.TLS_KEY_FILE ? { https: { cert: readFileSync(cfg.TLS_CERT_FILE), key: readFileSync(cfg.TLS_KEY_FILE) } } : {};
  const app = Fastify({ loggerInstance: p.log.child({ component: 'http' }), logController: new LogController({ disableRequestLogging: true }), bodyLimit: 2 * 1024 * 1024, trustProxy: false, ...https }) as unknown as FastifyInstance;

  app.addContentTypeParser(['application/octet-stream', 'application/x-strata-rangescan', 'image/png', 'image/jpeg', 'image/webp'], { parseAs: 'buffer', bodyLimit: 40 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', allowList: (req) => req.url.startsWith('/api/ingest') });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);
  app.addHook('onRequest', async (req) => {
    const token = readCookie(req, SESSION_COOKIE) ?? (req.url.startsWith('/api/ingest') ? null : bearer(req));
    if (token && token !== cfg.STRATA_SERVICE_TOKEN) {
      req.sessionToken = token;
      req.user = await p.auth.validate(token);
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    p.metrics.httpMs.observe(reply.elapsedTime);
    if (reply.statusCode >= 500) p.log.error({ url: req.url, status: reply.statusCode }, 'request failed');
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('x-frame-options', 'DENY');
    return payload;
  });
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) p.log.error({ err: err.message, stack: err.stack, url: req.url }, 'unhandled error');
    void reply.code(status).send({ error: status >= 500 ? 'internal error' : err.message });
  });

  registerCore(app, p);
  registerOperations(app, p);
  registerVision(app, p);
  registerCameras(app, p);
  registerOps(app, p);
  registerSite(app, p);
  registerInterop(app, p);

  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!req.user) {
      socket.close(4401, 'authentication required');
      return;
    }
    p.hub.add(socket, { type: 'hello', serverTime: Date.now(), liveEdge: p.liveEdge() });
  });

  if (cfg.WEB_DIST && existsSync(cfg.WEB_DIST)) {
    await app.register(fastifyStatic, { root: cfg.WEB_DIST, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
