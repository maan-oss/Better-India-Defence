import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';

/**
 * Serving the web build: real routes get the app shell, a missing build file is a 404 (a stale tab asks for code
 * that a deploy removed, and must fail rather than run HTML), and the API rate limit covers /api only.
 */
let dir: string;
let platform: Platform;
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-static-'));
  const web = join(dir, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Strata</title><meta name="csp-nonce" content="__CSP_NONCE__" />');
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log("app");');
  const cfg = loadConfig({ NODE_ENV: 'test', DATA_DIR: join(dir, 'data'), WEB_DIST: web, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
  platform = new Platform(cfg, createLogger('error', false));
  await platform.start();
  app = await buildApp(platform);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('serving the web build', () => {
  it('serves the app shell for a real route and the file for a real asset', async () => {
    const shell = await app.inject({ method: 'GET', url: '/operations' });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['content-type']).toMatch(/text\/html/);
    expect(shell.body).toContain('<title>Strata</title>');

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
  });

  it('serves the app shell for an application route under /assets (no file extension)', async () => {
    const page = await app.inject({ method: 'GET', url: '/assets/ast-demo-ups1' });
    expect(page.statusCode).toBe(200);
    expect(String(page.headers['content-type'])).toMatch(/html/);
  });

  it('answers a missing build file with a 404, never with the app shell', async () => {
    const missing = await app.inject({ method: 'GET', url: '/assets/Reconstructions-removed.js' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).not.toMatch(/text\/html/);
    expect(missing.body).not.toContain('<title>Strata</title>');
  });

  it('answers an unknown API path with a JSON 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/no-such-route' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toMatch(/application\/json/);
  });

  it('serves the shell with a fresh style nonce, and the policy admits exactly that nonce', async () => {
    const nonceOf = (body: string) => /<meta name="csp-nonce" content="([^"]+)"/.exec(body)?.[1];
    const first = await app.inject({ method: 'GET', url: '/' });
    const second = await app.inject({ method: 'GET', url: '/operations' });
    const n1 = nonceOf(first.body);
    const n2 = nonceOf(second.body);
    expect(n1).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(n1).not.toBe('__CSP_NONCE__');
    expect(n2).not.toBe(n1);
    expect(String(first.headers['content-security-policy'])).toContain(`style-src 'self' 'nonce-${n1}'`);
    expect(String(second.headers['content-security-policy'])).toContain(`style-src 'self' 'nonce-${n2}'`);
    expect(first.headers['cache-control']).toBe('no-store');
  });

  it('gives an API response no style nonce, and never serves the raw shell file', async () => {
    const api = await app.inject({ method: 'GET', url: '/api/no-such-route' });
    expect(String(api.headers['content-security-policy'])).toContain("style-src 'self';");
    const raw = await app.inject({ method: 'GET', url: '/index.html' });
    expect(raw.statusCode).toBe(404);
  });

  it('does not rate-limit static files, but does limit the API', async () => {
    // The page code for one visit is many files; a burst of them must not look like an attack.
    const statuses: number[] = [];
    for (let i = 0; i < 620; i++) statuses.push((await app.inject({ method: 'GET', url: '/assets/app.js' })).statusCode);
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);

    const api: number[] = [];
    for (let i = 0; i < 620; i++) api.push((await app.inject({ method: 'GET', url: '/api/health' })).statusCode);
    expect(api).toContain(429);
  }, 60_000);
});
