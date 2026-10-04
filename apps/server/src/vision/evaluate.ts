/**
 * Face verification benchmark: `npm run vision:eval -w @strata/server -- --pairs <dir> [--out report.json]`
 *
 * <dir> contains image pairs named NNNN_L_a.<ext> / NNNN_L_b.<ext> where L = 1 (same person) or 0
 * (different people). Reports detection failures, the ROC (false-accept vs false-reject rate) and the
 * thresholds that give FAR = 1%, 0.1%. Run it on imagery representative of your cameras: accuracy on
 * public web photos does not transfer to CCTV at distance, at night or through haze.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cosine } from '@strata/domain/vision';
import { VisionEngine, findModelsDir } from './engine.ts';
import { decodeImage } from './imageio.ts';

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dir = arg('pairs');
if (!dir) {
  console.error('usage: evaluate --pairs <dir> [--out report.json] [--limit N]');
  process.exit(2);
}
const limit = Number(arg('limit') ?? Infinity);
const engine = new VisionEngine(findModelsDir(arg('models')));
const files = readdirSync(dir).filter((f) => /^\d+_[01]_[ab]\.(jpe?g|png)$/i.test(f));
const allIds = [...new Set(files.map((f) => f.split('_')[0]!))].sort();
// Even sample across the set when --limit is given (pair files are usually grouped by label).
const ids = Number.isFinite(limit) && limit < allIds.length ? allIds.filter((_, i) => i % Math.ceil(allIds.length / limit) === 0) : allIds;

const embedLargest = async (file: string) => {
  const img = decodeImage(readFileSync(join(dir, file)));
  const faces = await engine.faces(img, { max: 1, tiled: false });
  return faces[0] ?? null;
};

const scores: { same: boolean; score: number }[] = [];
let noFace = 0;
let unusable = 0;
const t0 = Date.now();
for (const id of ids) {
  const a = files.find((f) => f.startsWith(`${id}_`) && /_a\./.test(f));
  const b = files.find((f) => f.startsWith(`${id}_`) && /_b\./.test(f));
  if (!a || !b) continue;
  const same = a.split('_')[1] === '1';
  const [fa, fb] = [await embedLargest(a), await embedLargest(b)];
  if (!fa || !fb) {
    noFace++;
    continue;
  }
  if (!fa.embedding || !fb.embedding) {
    unusable++;
    continue;
  }
  scores.push({ same, score: cosine(fa.embedding, fb.embedding) });
}
const ms = (Date.now() - t0) / Math.max(1, ids.length * 2);

const genuine = scores.filter((s) => s.same).map((s) => s.score);
const impostor = scores.filter((s) => !s.same).map((s) => s.score);
const rate = (arr: number[], f: (v: number) => boolean) => arr.filter(f).length / Math.max(1, arr.length);
const roc: { threshold: number; far: number; frr: number }[] = [];
for (let t = 0; t <= 0.8001; t += 0.01) roc.push({ threshold: Math.round(t * 100) / 100, far: rate(impostor, (v) => v >= t), frr: rate(genuine, (v) => v < t) });
const atFar = (target: number) => roc.find((r) => r.far <= target) ?? roc[roc.length - 1]!;
let best = roc[0]!;
for (const r of roc) if (1 - (r.far + r.frr) / 2 > 1 - (best.far + best.frr) / 2) best = r;
const eer = roc.reduce((a, r) => (Math.abs(r.far - r.frr) < Math.abs(a.far - a.frr) ? r : a), roc[0]!);

const report = {
  dataset: dir,
  pairs: ids.length,
  scored: scores.length,
  genuinePairs: genuine.length,
  impostorPairs: impostor.length,
  noFaceDetected: noFace,
  unusableFaceQuality: unusable,
  msPerImage: Math.round(ms),
  bestAccuracy: { threshold: best.threshold, accuracy: Math.round((1 - (best.far + best.frr) / 2) * 10000) / 100 },
  equalErrorRate: { threshold: eer.threshold, rate: Math.round(((eer.far + eer.frr) / 2) * 10000) / 100 },
  at1PctFar: atFar(0.01),
  at01PctFar: atFar(0.001),
  roc,
};
console.log(JSON.stringify({ ...report, roc: undefined }, null, 2));
const out = arg('out');
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
