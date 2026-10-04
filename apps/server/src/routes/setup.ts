import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FACILITY } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { audit, parse, requirePerm } from '../http/guards.ts';

/** Exit code that asks the supervisor (scripts/start.mjs, scripts/dev.mjs, the container runtime) to start the service again. */
export const RESTART_EXIT_CODE = 75;

const normalise = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
function codeMatches(expected: string | null, given: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(normalise(given));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * First-run setup for an operational install. Until an administrator exists, the console shows the setup
 * wizard; the one-time code printed in the service log proves the person at the console also controls the
 * server. After the first administrator is created the code is destroyed and these routes refuse.
 */
export function registerSetup(app: FastifyInstance, p: Platform): void {
  app.get('/api/setup/status', async () => ({
    mode: p.cfg.STRATA_MODE,
    needsSetup: p.needsSetup,
    needsAdmin: p.setupCode !== null,
    needsSite: !p.demo && p.site === null,
    site: p.site ? { id: p.site.id, name: p.site.name, origin: p.site.origin } : p.demo ? { id: FACILITY.id, name: FACILITY.name, origin: FACILITY.origin } : null,
  }));

  app.post('/api/setup/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(z.object({ code: z.string().min(4).max(32) }), req.body, reply);
    if (!b) return;
    if (!p.setupCode) return reply.code(409).send({ error: 'setup is already complete' });
    if (!codeMatches(p.setupCode, b.code)) return reply.code(403).send({ error: 'that code does not match the one in the service log' });
    return { ok: true };
  });

  app.post('/api/setup/admin', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(
      z.object({
        code: z.string().min(4).max(32),
        username: z.string().regex(/^[a-z0-9._-]{3,32}$/, 'lower-case letters, digits, dot, dash or underscore (3–32)'),
        displayName: z.string().min(2).max(80),
        password: z.string().min(12, 'at least 12 characters').max(256),
      }),
      req.body,
      reply,
    );
    if (!b) return;
    if (!p.setupCode || (await p.auth.count()) > 0) return reply.code(409).send({ error: 'setup is already complete' });
    if (!codeMatches(p.setupCode, b.code)) return reply.code(403).send({ error: 'that code does not match the one in the service log' });
    const user = await p.auth.create(b.username, b.displayName, 'administrator', b.password);
    p.setupCode = null;
    await rm(join(p.cfg.dataDir, 'setup-code.txt'), { force: true });
    await p.audit.append({ actor: user.username, role: user.role, action: 'setup_admin_created', target: user.id, detail: { displayName: user.displayName }, ip: req.ip });
    p.log.info({ user: user.username }, 'first administrator created; setup code destroyed');
    return { ok: true, user };
  });

  /** Apply a saved site definition (or other start-up configuration) by restarting the service. */
  app.post('/api/system/restart', { preHandler: requirePerm('admin.config') }, async (req) => {
    await audit(p, req, 'service_restart_requested', FACILITY.id, {});
    p.log.warn({ by: req.user?.username }, 'restart requested from the console');
    setTimeout(() => {
      void p.stop().finally(() => process.exit(RESTART_EXIT_CODE));
    }, 300);
    return { ok: true, restarting: true };
  });
}
