import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { can, type Permission, type UserRecord } from '@strata/domain';
import type { z } from 'zod';
import type { Platform } from '../platform.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRecord | null;
    sessionToken: string | null;
  }
}

export const SESSION_COOKIE = 'strata_session';

export function readCookie(req: FastifyRequest, name: string): string | null {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
}

export function isService(req: FastifyRequest, token: string): boolean {
  const got = Buffer.from(bearer(req) ?? '');
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** preHandler factory enforcing a capability. */
export function requirePerm(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: 'authentication required' });
    if (!can(req.user.role, permission)) return reply.code(403).send({ error: `role ${req.user.role} lacks permission ${permission}` });
  };
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, reply: FastifyReply): z.infer<T> | null {
  const r = schema.safeParse(data);
  if (!r.success) {
    void reply.code(400).send({ error: 'invalid request', issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    return null;
  }
  return r.data as z.infer<T>;
}

export function audit(p: Platform, req: FastifyRequest, action: string, target: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  return p.audit.append({ actor: req.user?.username ?? 'anonymous', role: req.user?.role ?? 'none', action, target, detail, ip: req.ip });
}
