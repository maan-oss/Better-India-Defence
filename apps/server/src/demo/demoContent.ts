import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EnuFrame, FACILITY } from '@strata/domain';
import type { Platform } from '../platform.ts';

/**
 * Demonstration content for the demo site (never a configured site): two enrolled people with SYNTHETIC
 * faces (people who do not exist), two sample evidence items, and a face-capture camera at the Operations
 * Centre door that plays a generated recording — so recognition, sightings, review and the camera wall run
 * end to end on first launch. Runs once; recorded in config as `demo.content`.
 */
export function demoAssetsDir(): string | null {
  const cands = [resolve(import.meta.dirname, '../demo-assets'), resolve(import.meta.dirname, '../../demo-assets'), resolve('apps/server/demo-assets')];
  return cands.find((c) => existsSync(join(c, 'subject-a.jpg'))) ?? null;
}

export async function seedDemoContent(p: Platform, importDir: string): Promise<void> {
  if (p.site !== null) return;
  const done = (await p.db.query(`SELECT 1 FROM config WHERE key = 'demo.content'`)).rows.length > 0;
  if (done) return;
  const dir = demoAssetsDir();
  if (!dir) {
    p.log.warn('demo assets not found; skipping demonstration content');
    return;
  }
  const by = { username: 'system', role: 'administrator', ip: null };
  p.log.info('seeding demonstration content (synthetic identities, sample evidence, demo face-capture camera)');

  // 1. Identity register.
  const enrol = async (file: string, input: Parameters<Platform['identity']['createIdentity']>[0]) => {
    const bytes = new Uint8Array(await readFile(join(dir, file)));
    const r = await p.vision.interactive.run('analyze_image', { bytes, objects: false, faces: true, tiled: false, maxFaces: 3 });
    const face = r.faces.find((f) => f.embedding);
    const ident = await p.identity.createIdentity(input, 'system');
    if (face) await p.identity.addTemplate(ident.id, face, `demo:${file}`, r.sha256, 'system');
    return ident;
  };
  try {
    await enrol('subject-a.jpg', {
      list: 'AUTHORISED',
      category: 'Personnel',
      name: 'Sgt A. Verma (demo, synthetic face)',
      serviceNo: 'DEMO-0417',
      rank: 'Sergeant',
      unit: 'Station Security Flight',
      accessZones: ['zn-ops'],
      notes: 'Demonstration entry. The photograph is a synthetic face of a person who does not exist.',
    });
    await enrol('subject-b.jpg', {
      list: 'WATCHLIST',
      category: 'Person of interest',
      name: 'Subject KILO-7 (demo, synthetic face)',
      accessZones: [],
      threatLevel: 'MEDIUM',
      basis: 'Demonstration entry only — synthetic face of a person who does not exist. Shows the watch-list workflow.',
      notes: 'Deny entry and escort to the guard room; inform the duty officer (demonstration instruction).',
    });
  } catch (e) {
    p.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'demo identities not created (vision models missing?)');
  }

  // 2. Evidence library samples.
  for (const [file, title, notes] of [
    ['scene.jpg', 'Sample — aerial survey frame (VisDrone2019, CC BY-SA)', 'Public-dataset frame used to demonstrate detection of people and vehicles at range.'],
    ['subject-a-cctv.jpg', 'Sample — CCTV still with a face (synthetic composite)', 'Composite of a synthetic face onto a public-dataset frame, degraded to CCTV quality.'],
  ] as const) {
    try {
      const stored = await p.store.putStream('evidence', createReadStream(join(dir, file)), 50 * 1024 * 1024);
      await p.evidence.ingest(stored, { title, originalName: file, mime: 'image/jpeg', source: 'demo', capturedAt: null, capturedAtBasis: null, lat: null, lon: null, incidentId: null, classification: 'UNCLASSIFIED', notes, analyze: true, mode: 'standard' }, by);
    } catch (e) {
      p.log.warn({ file, err: e instanceof Error ? e.message : String(e) }, 'demo evidence not ingested');
    }
  }

  // 3. A face-capture camera playing a generated recording (requires ffmpeg).
  if (p.vision.ffmpeg) {
    try {
      const clip = join(importDir, 'demo-ops-door.mp4');
      if (!existsSync(clip)) await makeDoorClip(dir, clip);
      const g = new EnuFrame(FACILITY.origin).toGeodetic({ x: 90, y: 196, z: 0 });
      await p.cameras.upsert(
        {
          id: 'OPS-DOOR',
          name: 'Operations Centre door — face capture (demo recording)',
          binding: 'new',
          url: 'demo-ops-door.mp4',
          enabled: true,
          pose: { lat: g.lat, lon: g.lon, heightM: 2.4, headingDeg: 180, pitchDeg: -8, hfovDeg: 48 },
          segment: 'core',
          zoneId: 'zn-ops',
          analyticsFps: 1,
          detectObjects: true,
          recogniseFaces: true,
          tiled: false,
          loopFile: true,
        },
        'system',
      );
    } catch (e) {
      p.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'demo camera not created');
    }
  }
  await p.db.query(`INSERT INTO config (key, value, updated_by, updated_at) VALUES ('demo.content', '{"seeded":true}'::jsonb, 'system', $1) ON CONFLICT (key) DO NOTHING`, [Date.now()]);
}

/**
 * Access-point camera recording: an empty lane, the authorised person, empty lane, the watch-list subject —
 * each a slow drifting close view with sensor noise and compression, 1280×720 at 10 fps, ~100 s.
 */
function makeDoorClip(dir: string, out: string): Promise<void> {
  const face = (i: number) =>
    `[${i}]scale=-2:640,pad=1280:720:(ow-iw)/2:40:color=0x2b2f33,crop=1180:660:'50+t*5':'30+t*2',scale=1280:720,eq=brightness=-0.04:contrast=0.92,noise=alls=7:allf=t,gblur=sigma=0.6,fps=10,format=yuv420p,setsar=1[v${i}]`;
  const lane = (i: number) => `[${i}]format=yuv420p,noise=alls=6:allf=t,fps=10,setsar=1[v${i}]`;
  const args = [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-t', '38', '-i', 'color=c=0x2b2f33:s=1280x720:r=10',
    '-loop', '1', '-t', '12', '-i', join(dir, 'subject-a.jpg'),
    '-f', 'lavfi', '-t', '38', '-i', 'color=c=0x2b2f33:s=1280x720:r=10',
    '-loop', '1', '-t', '12', '-i', join(dir, 'subject-b.jpg'),
    '-filter_complex', `${lane(0)};${face(1)};${lane(2)};${face(3)};[v0][v1][v2][v3]concat=n=4:v=1:a=0[o]`,
    '-map', '[o]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', out,
  ];
  return new Promise((res, rej) => {
    const c = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d: Buffer) => (err += d.toString()));
    c.on('error', rej);
    c.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg ${code}: ${err.slice(0, 400)}`))));
  });
}
