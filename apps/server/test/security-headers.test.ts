import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';
import { contentSecurityPolicy, tileOrigin } from '../src/http/csp.ts';

/** Content Security Policy: the policy text, the basemap origin it admits, and that every response carries it. */
const directives = (policy: string) =>
  Object.fromEntries(
    policy.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  ) as Record<string, string[]>;

describe('tile origin', () => {
  it('keeps the origin of a basemap template and drops its path and placeholders', () => {
    expect(tileOrigin('https://tiles.example.mil/xyz/{z}/{x}/{y}.png')).toBe('https://tiles.example.mil');
    expect(tileOrigin('http://10.0.0.5:8080/{z}/{x}/{y}.jpg?key=none')).toBe('http://10.0.0.5:8080');
  });

  it('is null when there is no usable template', () => {
    expect(tileOrigin(null)).toBeNull();
    expect(tileOrigin(undefined)).toBeNull();
    expect(tileOrigin('not a url')).toBeNull();
    expect(tileOrigin('')).toBeNull();
  });
});

describe('content security policy', () => {
  it('refuses inline scripts, framing and plugins, and fetches only from this host without a basemap', () => {
    const d = directives(contentSecurityPolicy(null));
    expect(d['script-src']).toEqual(["'self'"]);
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(d['connect-src']).toEqual(["'self'", 'ws:', 'wss:']);
  });

  it('admits the configured basemap origin for images, and nothing else', () => {
    const d = directives(contentSecurityPolicy('https://tiles.example.mil/{z}/{x}/{y}.png'));
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https://tiles.example.mil']);
    expect(d['script-src']).toEqual(["'self'"]);
    expect(d['connect-src']).toEqual(["'self'", 'ws:', 'wss:']);
  });
});

describe('security headers on responses', () => {
  let dir: string;
  let platform: Platform;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'strata-csp-'));
    platform = new Platform(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' }), createLogger('error', false));
    await platform.start();
    app = await buildApp(platform);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await platform?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends the policy on an API response, alongside the other hardening headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});
