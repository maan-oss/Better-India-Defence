import type { TrackSnapshot, Vec3 } from '@strata/domain';
import { get, qs } from '../api/client';
import type { TrackWindow } from '../api/types';

export const STATUS_CODES = ['tentative', 'confirmed', 'coasting', 'lost', 'closed'] as const;
const STRIDE = 8;
const CHUNK_MS = 10 * 60_000;

export interface RenderTrack {
  id: string;
  category: string;
  label: string;
  cooperative: boolean;
  classification: string;
  status: (typeof STATUS_CODES)[number];
  position: Vec3;
  sigmaH: number;
  confidence: number;
  inferred: boolean;
  lastConfirmedAt: number;
  lastConfirmedPosition: Vec3;
  trail: Vec3[];
  contributors: string[];
  /** Live only: another system's report about this track (interop). */
  reported?: { system: string; affiliation: string };
}

const MAX_SPEED: Record<string, number> = { aerial: 30, person: 3, vehicle: 25, unknown: 25 };

/**
 * Client-side track store for the 4D engine. Live mode consumes WebSocket snapshots; replay mode loads
 * 10-minute chunks of persisted track states and evaluates them at the playhead. Interpolation is only
 * performed between closely spaced confirmed samples — never across gaps or after loss of contact.
 */
class TrackStore {
  private chunks = new Map<number, TrackWindow | 'loading'>();
  private live: { t: number; tracks: TrackSnapshot[] }[] = [];
  private liveTrails = new Map<string, { t: number; p: Vec3 }[]>();
  version = 0;

  ingestLive(t: number, tracks: TrackSnapshot[]): void {
    this.live.push({ t, tracks });
    if (this.live.length > 3) this.live.shift();
    for (const tr of tracks) {
      const arr = this.liveTrails.get(tr.id) ?? [];
      const last = arr[arr.length - 1];
      if (!last || t - last.t >= 900) arr.push({ t, p: { ...tr.position } });
      while (arr.length && t - arr[0]!.t > 90_000) arr.shift();
      this.liveTrails.set(tr.id, arr);
    }
    this.version++;
  }

  invalidateRecent(): void {
    // The newest chunk keeps filling while live; drop it so replay near the live edge refetches.
    const newest = Math.max(...this.chunks.keys());
    if (Number.isFinite(newest)) this.chunks.delete(newest);
  }

  /** Ensure chunks around t are loaded. Returns true if data for t is available. */
  ensure(t: number): boolean {
    const c = Math.floor(t / CHUNK_MS) * CHUNK_MS;
    let ready = true;
    for (const k of [c - CHUNK_MS, c, c + CHUNK_MS]) {
      const have = this.chunks.get(k);
      if (have === undefined) {
        this.chunks.set(k, 'loading');
        get<TrackWindow>(`/api/replay/tracks?${qs({ from: k, to: k + CHUNK_MS })}`)
          .then((w) => {
            this.chunks.set(k, w);
            this.version++;
          })
          .catch(() => this.chunks.delete(k));
        if (k === c) ready = false;
      } else if (have === 'loading' && k === c) ready = false;
    }
    if (this.chunks.size > 14) {
      const keys = [...this.chunks.keys()].sort((a, b) => Math.abs(a - c) - Math.abs(b - c));
      for (const k of keys.slice(14)) this.chunks.delete(k);
    }
    return ready;
  }

  replayAt(t: number): RenderTrack[] {
    const c = Math.floor(t / CHUNK_MS) * CHUNK_MS;
    const merged = new Map<string, { meta: TrackWindow['tracks'][number]; samples: number[] }>();
    for (const k of [c - CHUNK_MS, c]) {
      const w = this.chunks.get(k);
      if (!w || w === 'loading') continue;
      for (const tr of w.tracks) {
        const m = merged.get(tr.id);
        if (m) m.samples = m.samples.concat(tr.samples);
        else merged.set(tr.id, { meta: tr, samples: tr.samples.slice() });
      }
    }
    const next = this.chunks.get(c + CHUNK_MS);
    const out: RenderTrack[] = [];
    for (const [id, { meta, samples }] of merged) {
      const extra = next && next !== 'loading' ? next.tracks.find((x) => x.id === id) : undefined;
      const all = extra ? samples.concat(extra.samples.slice(0, STRIDE * 4)) : samples;
      const rt = evaluate(meta, all, t);
      if (rt) out.push(rt);
    }
    return out;
  }

  liveAt(t: number): RenderTrack[] {
    const a = this.live[this.live.length - 2];
    const b = this.live[this.live.length - 1];
    if (!b) return [];
    const k = a && b.t > a.t ? Math.max(0, Math.min(1.5, (t - a.t) / (b.t - a.t))) : 1;
    const prev = new Map((a?.tracks ?? []).map((x) => [x.id, x]));
    return b.tracks
      .filter((x) => x.status !== 'closed')
      .map((x) => {
        const p = prev.get(x.id);
        const moving = x.status === 'confirmed' || x.status === 'tentative';
        const pos = p && moving ? { x: p.position.x + (x.position.x - p.position.x) * k, y: p.position.y + (x.position.y - p.position.y) * k, z: p.position.z + (x.position.z - p.position.z) * k } : x.position;
        return {
          id: x.id,
          category: x.category,
          label: x.label,
          cooperative: x.cooperative,
          classification: x.classification,
          status: x.status,
          position: pos,
          sigmaH: x.sigmaH,
          confidence: x.confidence,
          inferred: x.state === 'INFERRED',
          lastConfirmedAt: x.lastConfirmedAt,
          lastConfirmedPosition: x.lastConfirmedPosition,
          trail: (this.liveTrails.get(x.id) ?? []).map((s) => s.p),
          contributors: x.contributors,
          ...(x.reported ? { reported: { system: x.reported.system, affiliation: x.reported.affiliation } } : {}),
        };
      });
  }
}

function evaluate(meta: TrackWindow['tracks'][number], s: number[], t: number): RenderTrack | null {
  const n = s.length / STRIDE;
  let i = -1;
  // samples are sorted by time within each chunk; chunks are appended in order
  for (let k = 0; k < n; k++) {
    if (s[k * STRIDE]! <= t) i = k;
    else break;
  }
  if (i < 0) return null;
  const ti = s[i * STRIDE]!;
  const status = STATUS_CODES[s[i * STRIDE + 5]!] ?? 'tentative';
  if (status === 'closed') return null;
  const age = t - ti;
  if (age > 30 * 60_000) return null;
  let pos: Vec3 = { x: s[i * STRIDE + 1]!, y: s[i * STRIDE + 2]!, z: s[i * STRIDE + 3]! };
  let sigma = s[i * STRIDE + 4]!;
  let inferred = s[i * STRIDE + 7] === 1;
  let effStatus: RenderTrack['status'] = status;
  const j = i + 1 < n ? i + 1 : -1;
  if (j >= 0 && (status === 'confirmed' || status === 'tentative')) {
    const tj = s[j * STRIDE]!;
    const sj = STATUS_CODES[s[j * STRIDE + 5]!];
    if (tj - ti <= 8000 && (sj === 'confirmed' || sj === 'tentative')) {
      const k = (t - ti) / (tj - ti);
      pos = { x: pos.x + (s[j * STRIDE + 1]! - pos.x) * k, y: pos.y + (s[j * STRIDE + 2]! - pos.y) * k, z: pos.z + (s[j * STRIDE + 3]! - pos.z) * k };
      sigma = sigma + (s[j * STRIDE + 4]! - sigma) * k;
    } else if (age > 6000) {
      effStatus = 'coasting';
      inferred = true;
    }
  } else if (j < 0 && (status === 'confirmed' || status === 'tentative') && age > 6000) {
    effStatus = 'coasting';
    inferred = true;
  }
  // Last confirmed sample (for object-permanence display).
  let lc = i;
  while (lc > 0 && (STATUS_CODES[s[lc * STRIDE + 5]!] === 'lost' || STATUS_CODES[s[lc * STRIDE + 5]!] === 'coasting')) lc--;
  const lastConfirmedAt = s[lc * STRIDE]!;
  const lastConfirmedPosition = { x: s[lc * STRIDE + 1]!, y: s[lc * STRIDE + 2]!, z: s[lc * STRIDE + 3]! };
  if (effStatus === 'lost' || effStatus === 'coasting') {
    pos = lastConfirmedPosition;
    sigma = Math.max(sigma, Math.min(3000, (MAX_SPEED[meta.category] ?? 10) * ((t - lastConfirmedAt) / 1000)));
  }
  const trail: Vec3[] = [];
  for (let k = Math.max(0, i - 60); k <= i; k++) {
    const tk = s[k * STRIDE]!;
    if (t - tk > 60_000) continue;
    const st = STATUS_CODES[s[k * STRIDE + 5]!];
    if (st === 'lost' || st === 'coasting') continue;
    trail.push({ x: s[k * STRIDE + 1]!, y: s[k * STRIDE + 2]!, z: s[k * STRIDE + 3]! });
  }
  if (effStatus === 'confirmed' || effStatus === 'tentative') trail.push(pos);
  return {
    id: meta.id,
    category: meta.category,
    label: meta.label,
    cooperative: meta.cooperative,
    classification: meta.classification,
    status: effStatus,
    position: pos,
    sigmaH: sigma,
    confidence: s[i * STRIDE + 6]!,
    inferred,
    lastConfirmedAt,
    lastConfirmedPosition,
    trail,
    contributors: meta.contributors,
  };
}

export const tracks = new TrackStore();
