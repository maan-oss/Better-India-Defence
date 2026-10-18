import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';

/**
 * Asset register import: a dry run lists every problem and writes nothing; a commit writes every row or none; a tag taken
 * since the check refuses the import; and each import is in the audit log, with the history of each new asset.
 */
const PASSWORD = 'Kestrel-7-Orbit-mapping';
const HEAD = 'tag,name,category,criticality,classification,owner,commissioned_at,stock_quantity,reorder_level,stock_unit';
let dir: string;
let platform: Platform;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-import-'));
  const cfg = loadConfig({ NODE_ENV: 'test', STRATA_MODE: 'operational', STRATA_MFA_REQUIRED: 'false', DATA_DIR: dir, STRATA_ADMIN_PASSWORD: PASSWORD, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
  platform = new Platform(cfg, createLogger('error', false));
  await platform.start();
  await platform.auth.create('ops.logistics', 'Logistics Operator', 'operator', PASSWORD, { clearance: 'CONFIDENTIAL', organisation: 'logistics' });
  app = await buildApp(platform);
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ops.logistics', password: PASSWORD } });
  cookie = String(r.headers['set-cookie']).split(';')[0]!;
  await platform.assets.create({ tag: 'TAKEN-1', name: 'Already here', category: 'power', criticality: 2 }, 'seed');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const post = (csv: string, commit: boolean) => app.inject({ method: 'POST', url: '/api/assets/import', headers: { cookie }, payload: { csv, commit } });
const count = async () => Number((await platform.db.query<{ n: number }>('SELECT count(*)::int AS n FROM assets')).rows[0]!.n);

describe('asset import', () => {
  it('a dry run lists every problem by row and column, and writes nothing', async () => {
    const before = await count();
    const csv = `${HEAD}\nPUMP-A,Fuel pump,facilities,4,UNCLASSIFIED,logistics,2026-03-01,,,\nTAKEN-1,Clash,power,2,,,,,,\nBAD-2,x,power,9,,,,,,\nDSL-3,Diesel,supply,3,RESTRICTED,logistics,,500,200,litres\n`;
    const r = await post(csv, false);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.committed).toBe(false);
    expect(body.rows).toBe(2);
    expect(body.problems).toEqual([
      { row: 2, column: 'tag', message: 'tag TAKEN-1 is already in use' },
      { row: 3, column: 'criticality', message: expect.any(String) },
    ]);
    expect(body.preview.map((p: { tag: string }) => p.tag)).toEqual(['PUMP-A', 'DSL-3']);
    expect(await count()).toBe(before);
  });

  it('refuses a commit with any problem, and writes none of the rows', async () => {
    const before = await count();
    const r = await post(`${HEAD}\nOK-1,fine,power,2,,,,,,\nTAKEN-1,clash,power,2,,,,,,\n`, true);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/nothing was written/);
    expect(await count()).toBe(before);
  });

  it('commits a valid file in one step, with the history and the audit entry for it', async () => {
    const before = await count();
    const r = await post(`${HEAD}\nPUMP-A,Fuel pump,facilities,4,UNCLASSIFIED,logistics,2026-03-01,,,\nDSL-3,Diesel,supply,3,RESTRICTED,logistics,,500,200,litres\n`, true);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ committed: true, imported: 2 });
    expect(await count()).toBe(before + 2);
    const pump = (await platform.db.query<{ id: string; commissioned_at: number }>("SELECT id, commissioned_at FROM assets WHERE tag = 'PUMP-A'")).rows[0]!;
    expect(Number(pump.commissioned_at)).toBe(Date.parse('2026-03-01T00:00:00Z'));
    const events = (await platform.db.query<{ kind: string }>('SELECT kind FROM asset_events WHERE asset_id = $1', [pump.id])).rows;
    expect(events.map((e) => e.kind)).toEqual(['created']);
    const audit = (await platform.db.query<{ action: string; detail: { imported: number } }>("SELECT action, detail FROM audit_events WHERE action = 'asset_import' ORDER BY seq DESC LIMIT 1")).rows[0]!;
    expect(audit.detail.imported).toBe(2);
  });

  it('refuses a second import of the same tags, since they are now in use', async () => {
    const r = await post(`${HEAD}\nPUMP-A,Fuel pump,facilities,4,UNCLASSIFIED,logistics,,,,\n`, false);
    expect(r.json().problems).toEqual([{ row: 1, column: 'tag', message: 'tag PUMP-A is already in use' }]);
  });

  it('applies the clearance rule to the rows of a file, the same as to one asset', async () => {
    const r = await post(`${HEAD}\nTOP-9,Secret thing,power,2,SECRET,logistics,,,,\n`, false);
    expect(r.json().problems).toEqual([{ row: 1, column: 'classification', message: 'above your clearance' }]);
  });
});
