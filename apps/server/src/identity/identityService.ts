import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FACILITY, type EvidenceRef, type Vec3 } from '@strata/domain';
import { cosine } from '@strata/domain/vision';
import type { Db } from '../db/client.ts';
import type { ObjectStore } from '../storage/objectStore.ts';
import type { AlertEngine } from '../alerts/alertEngine.ts';
import type { LiveHub } from '../live/hub.ts';
import type { FaceOut } from '../vision/worker.ts';

/**
 * Identity registry and face matching.
 *
 * - AUTHORISED list: personnel, contractors and visitors permitted on site, with the zones they may enter.
 * - WATCHLIST: persons of interest. Each entry records the basis (authority/source) for listing.
 *
 * Matching is 1:N cosine similarity between SFace embeddings. Decisions use two thresholds measured on a
 * public benchmark (see docs/REALITY_LIMITS.md): STRONG ≥ strong, POSSIBLE ≥ possible. Every watchlist
 * candidate goes to a human review queue; the system never acts on an identity on its own.
 */
export const FACE_MODEL = 'sface-2021dec';

export const FaceSettings = z.object({
  strong: z.number().min(0.2).max(0.9),
  possible: z.number().min(0.1).max(0.9),
  /** Minimum face quality to attempt a match. */
  minGrade: z.enum(['GOOD', 'FAIR', 'POOR']),
  /** Days to keep face sightings with no match (privacy / storage). Matched and reviewed sightings are kept. */
  retentionDays: z.number().int().min(1).max(3650),
  /** Raise an alert for unrecognised faces seen by cameras covering restricted zones. */
  alertUnknownInRestricted: z.boolean(),
});
export type FaceSettings = z.infer<typeof FaceSettings>;

export const DEFAULT_FACE_SETTINGS: FaceSettings = { strong: 0.42, possible: 0.32, minGrade: 'POOR', retentionDays: 30, alertUnknownInRestricted: true };

const GRADE_RANK = { UNUSABLE: 0, POOR: 1, FAIR: 2, GOOD: 3 } as const;

export const IdentityInput = z.object({
  list: z.enum(['AUTHORISED', 'WATCHLIST']),
  category: z.string().min(2).max(40),
  name: z.string().min(2).max(120),
  serviceNo: z.string().max(40).nullish(),
  rank: z.string().max(40).nullish(),
  unit: z.string().max(80).nullish(),
  organisation: z.string().max(120).nullish(),
  accessZones: z.array(z.string().max(40)).max(50).default([]),
  threatLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullish(),
  basis: z.string().max(1000).nullish(),
  notes: z.string().max(2000).nullish(),
  validUntil: z.number().int().nullish(),
});
export type IdentityInput = z.infer<typeof IdentityInput>;

export interface Identity {
  id: string;
  list: 'AUTHORISED' | 'WATCHLIST';
  category: string;
  name: string;
  serviceNo: string | null;
  rank: string | null;
  unit: string | null;
  organisation: string | null;
  accessZones: string[];
  threatLevel: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  basis: string | null;
  notes: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  validUntil: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  templates: number;
  photoTemplateId: string | null;
}

export interface Candidate {
  identityId: string;
  name: string;
  list: 'AUTHORISED' | 'WATCHLIST';
  score: number;
  templateId: string;
}

export interface FaceEventRecord {
  id: string;
  t: number;
  sourceKind: 'camera' | 'evidence';
  sourceId: string;
  tMedia: number | null;
  box: { x: number; y: number; w: number; h: number };
  quality: FaceOut['quality'];
  bestIdentityId: string | null;
  bestScore: number | null;
  candidates: Candidate[];
  decision: 'STRONG' | 'POSSIBLE' | 'NO_MATCH' | 'NOT_COMPARABLE';
  reviewStatus: 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'NOT_REQUIRED';
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewNote: string | null;
  zoneId: string | null;
  alertId: string | null;
  position: { x: number; y: number } | null;
}

interface IdentityRow {
  id: string;
  list: 'AUTHORISED' | 'WATCHLIST';
  category: string;
  name: string;
  service_no: string | null;
  rank: string | null;
  unit: string | null;
  organisation: string | null;
  access_zones: string[];
  threat_level: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  basis: string | null;
  notes: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  valid_until: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  templates?: number;
  photo_template_id?: string | null;
}

interface FaceEventRow {
  id: string;
  t: number;
  source_kind: 'camera' | 'evidence';
  source_id: string;
  t_media: number | null;
  box: FaceEventRecord['box'];
  quality: FaceOut['quality'];
  best_identity_id: string | null;
  best_score: number | null;
  candidates: Candidate[];
  decision: FaceEventRecord['decision'];
  review_status: FaceEventRecord['reviewStatus'];
  reviewed_by: string | null;
  reviewed_at: number | null;
  review_note: string | null;
  zone_id: string | null;
  alert_id: string | null;
  x: number | null;
  y: number | null;
}

const toIdentity = (r: IdentityRow): Identity => ({
  id: r.id,
  list: r.list,
  category: r.category,
  name: r.name,
  serviceNo: r.service_no,
  rank: r.rank,
  unit: r.unit,
  organisation: r.organisation,
  accessZones: r.access_zones,
  threatLevel: r.threat_level,
  basis: r.basis,
  notes: r.notes,
  status: r.status,
  validUntil: r.valid_until,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  templates: Number(r.templates ?? 0),
  photoTemplateId: r.photo_template_id ?? null,
});

const toFaceEvent = (r: FaceEventRow): FaceEventRecord => ({
  id: r.id,
  t: r.t,
  sourceKind: r.source_kind,
  sourceId: r.source_id,
  tMedia: r.t_media,
  box: r.box,
  quality: r.quality,
  bestIdentityId: r.best_identity_id,
  bestScore: r.best_score === null ? null : Math.round(r.best_score * 1000) / 1000,
  candidates: r.candidates,
  decision: r.decision,
  reviewStatus: r.review_status,
  reviewedBy: r.reviewed_by,
  reviewedAt: r.reviewed_at,
  reviewNote: r.review_note,
  zoneId: r.zone_id,
  alertId: r.alert_id,
  position: r.x !== null && r.y !== null ? { x: r.x, y: r.y } : null,
});

export class IdentityError extends Error {}

/** Same identity at the same camera within this window is treated as one sighting. */
const RESIGHT_MS = 10 * 60_000;

export class IdentityService {
  private readonly recentSightings = new Map<string, { t: number; rank: number }>();
  private gallery: { templateId: string; identityId: string; emb: Float32Array }[] = [];
  private identities = new Map<string, Identity>();
  settings: FaceSettings = DEFAULT_FACE_SETTINGS;

  constructor(
    private readonly db: Db,
    private readonly store: ObjectStore,
    private readonly alerts: AlertEngine,
    private readonly hub: LiveHub,
  ) {}

  async load(): Promise<void> {
    const s = (await this.db.query<{ value: unknown }>(`SELECT value FROM config WHERE key = 'face.settings'`)).rows[0];
    if (s) {
      const p = FaceSettings.safeParse(s.value);
      if (p.success) this.settings = p.data;
    }
    await this.reloadGallery();
  }

  async saveSettings(s: FaceSettings, by: string): Promise<void> {
    if (s.possible > s.strong) throw new IdentityError('possible threshold must not exceed strong threshold');
    this.settings = s;
    await this.db.query(`INSERT INTO config (key, value, updated_by, updated_at) VALUES ('face.settings', $1::jsonb, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`, [JSON.stringify(s), by, Date.now()]);
  }

  async reloadGallery(): Promise<void> {
    const ids = await this.listIdentities({ includeRemoved: true });
    this.identities = new Map(ids.map((i) => [i.id, i]));
    const rows = (await this.db.query<{ id: string; identity_id: string; embedding: number[] }>(`SELECT t.id, t.identity_id, t.embedding FROM identity_templates t JOIN identities i ON i.id = t.identity_id WHERE i.status = 'ACTIVE' AND t.model = $1`, [FACE_MODEL])).rows;
    this.gallery = rows.map((r) => ({ templateId: r.id, identityId: r.identity_id, emb: Float32Array.from(r.embedding) }));
  }

  get gallerySize(): { identities: number; templates: number; watchlist: number; authorised: number } {
    const active = [...this.identities.values()].filter((i) => i.status === 'ACTIVE');
    return { identities: active.length, templates: this.gallery.length, watchlist: active.filter((i) => i.list === 'WATCHLIST').length, authorised: active.filter((i) => i.list === 'AUTHORISED').length };
  }

  // -------------------------------------------------------------------------------------------------------
  // Registry

  async listIdentities(o: { list?: 'AUTHORISED' | 'WATCHLIST'; q?: string; includeRemoved?: boolean } = {}): Promise<Identity[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (o.list) {
      params.push(o.list);
      where.push(`i.list = $${params.length}`);
    }
    if (!o.includeRemoved) where.push(`i.status <> 'REMOVED'`);
    if (o.q) {
      params.push(`%${o.q.toLowerCase()}%`);
      where.push(`(lower(i.name) LIKE $${params.length} OR lower(coalesce(i.service_no,'')) LIKE $${params.length} OR lower(coalesce(i.unit,'')) LIKE $${params.length})`);
    }
    const rows = (
      await this.db.query<IdentityRow>(
        `SELECT i.*, (SELECT count(*)::int FROM identity_templates t WHERE t.identity_id = i.id) AS templates,
                (SELECT t.id FROM identity_templates t WHERE t.identity_id = i.id ORDER BY t.created_at LIMIT 1) AS photo_template_id
         FROM identities i ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.list, i.name`,
        params,
      )
    ).rows;
    return rows.map(toIdentity);
  }

  async getIdentity(id: string): Promise<Identity | null> {
    const r = (await this.db.query<IdentityRow>(`SELECT i.*, (SELECT count(*)::int FROM identity_templates t WHERE t.identity_id = i.id) AS templates, (SELECT t.id FROM identity_templates t WHERE t.identity_id = i.id ORDER BY t.created_at LIMIT 1) AS photo_template_id FROM identities i WHERE i.id = $1`, [id])).rows[0];
    return r ? toIdentity(r) : null;
  }

  async createIdentity(input: IdentityInput, by: string): Promise<Identity> {
    if (input.list === 'WATCHLIST' && !input.basis?.trim()) throw new IdentityError('a watchlist entry requires a documented basis (authority / source / reason)');
    const zones = new Set(FACILITY.zones.map((z) => z.id));
    for (const z of input.accessZones) if (!zones.has(z)) throw new IdentityError(`unknown zone ${z}`);
    const id = `idn-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await this.db.query(
      `INSERT INTO identities (id, list, category, name, service_no, rank, unit, organisation, access_zones, threat_level, basis, notes, status, valid_until, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,'ACTIVE',$13,$14,$15,$15)`,
      [id, input.list, input.category, input.name, input.serviceNo ?? null, input.rank ?? null, input.unit ?? null, input.organisation ?? null, JSON.stringify(input.accessZones), input.list === 'WATCHLIST' ? (input.threatLevel ?? 'MEDIUM') : null, input.basis ?? null, input.notes ?? null, input.validUntil ?? null, by, now],
    );
    await this.reloadGallery();
    return (await this.getIdentity(id))!;
  }

  async updateIdentity(id: string, patch: Partial<IdentityInput> & { status?: Identity['status'] }): Promise<Identity> {
    const cur = await this.getIdentity(id);
    if (!cur) throw new IdentityError('unknown identity');
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Identity & Partial<IdentityInput>;
    if (next.list === 'WATCHLIST' && !next.basis?.trim()) throw new IdentityError('a watchlist entry requires a documented basis');
    await this.db.query(
      `UPDATE identities SET category=$2, name=$3, service_no=$4, rank=$5, unit=$6, organisation=$7, access_zones=$8::jsonb, threat_level=$9, basis=$10, notes=$11, status=$12, valid_until=$13, updated_at=$14 WHERE id=$1`,
      [id, next.category, next.name, next.serviceNo ?? null, next.rank ?? null, next.unit ?? null, next.organisation ?? null, JSON.stringify(next.accessZones ?? []), next.list === 'WATCHLIST' ? (next.threatLevel ?? 'MEDIUM') : null, next.basis ?? null, next.notes ?? null, next.status, next.validUntil ?? null, Date.now()],
    );
    await this.reloadGallery();
    return (await this.getIdentity(id))!;
  }

  /** Enrol one face (from an analysed image) as a template for an identity. */
  async addTemplate(identityId: string, face: FaceOut, source: string, sha256Source: string | null, by: string): Promise<{ id: string; duplicateOf: Candidate | null }> {
    const ident = await this.getIdentity(identityId);
    if (!ident) throw new IdentityError('unknown identity');
    if (!face.embedding) throw new IdentityError(`face quality too low to enrol (${face.quality.reasons.join('; ') || face.quality.grade})`);
    if (GRADE_RANK[face.quality.grade] < GRADE_RANK.FAIR) throw new IdentityError(`enrolment needs at least FAIR quality; this face is ${face.quality.grade} (${face.quality.reasons.join('; ')})`);
    // Guard against enrolling a face that already strongly matches a *different* identity.
    const dup = this.match(face.embedding).find((c) => c.identityId !== identityId && c.score >= this.settings.strong) ?? null;
    const crop = await this.store.put('faces/enrol', face.crop);
    const aligned = await this.store.put('faces/enrol', face.aligned);
    const id = `tpl-${randomUUID().slice(0, 8)}`;
    await this.db.query(
      `INSERT INTO identity_templates (id, identity_id, embedding, model, quality, crop_key, aligned_key, encrypted, source, sha256_source, created_by, created_at) VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)`,
      [id, identityId, JSON.stringify(face.embedding), FACE_MODEL, JSON.stringify(face.quality), crop.key, aligned.key, crop.encrypted, source, sha256Source, by, Date.now()],
    );
    await this.reloadGallery();
    return { id, duplicateOf: dup };
  }

  async removeTemplate(templateId: string): Promise<void> {
    await this.db.query('DELETE FROM identity_templates WHERE id = $1', [templateId]);
    await this.reloadGallery();
  }

  async templates(identityId: string): Promise<{ id: string; quality: FaceOut['quality']; source: string; createdBy: string; createdAt: number }[]> {
    return (await this.db.query<{ id: string; quality: FaceOut['quality']; source: string; created_by: string; created_at: number }>('SELECT id, quality, source, created_by, created_at FROM identity_templates WHERE identity_id = $1 ORDER BY created_at', [identityId])).rows.map((r) => ({
      id: r.id,
      quality: r.quality,
      source: r.source,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  async templateImage(templateId: string, which: 'crop' | 'aligned'): Promise<Uint8Array | null> {
    const r = (await this.db.query<{ crop_key: string; aligned_key: string; encrypted: boolean }>('SELECT crop_key, aligned_key, encrypted FROM identity_templates WHERE id = $1', [templateId])).rows[0];
    return r ? this.store.get(which === 'crop' ? r.crop_key : r.aligned_key, r.encrypted) : null;
  }

  // -------------------------------------------------------------------------------------------------------
  // Matching

  /** Best score per identity (max over its templates), highest first. */
  match(embedding: ArrayLike<number>, limit = 5): Candidate[] {
    const best = new Map<string, { score: number; templateId: string }>();
    for (const g of this.gallery) {
      const s = cosine(embedding, g.emb);
      const cur = best.get(g.identityId);
      if (!cur || s > cur.score) best.set(g.identityId, { score: s, templateId: g.templateId });
    }
    return [...best.entries()]
      .map(([identityId, b]) => {
        const i = this.identities.get(identityId);
        return { identityId, name: i?.name ?? identityId, list: i?.list ?? 'AUTHORISED', score: Math.round(b.score * 1000) / 1000, templateId: b.templateId };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  decide(face: FaceOut): { decision: FaceEventRecord['decision']; candidates: Candidate[] } {
    if (!face.embedding || GRADE_RANK[face.quality.grade] < GRADE_RANK[this.settings.minGrade]) return { decision: 'NOT_COMPARABLE', candidates: [] };
    const candidates = this.match(face.embedding);
    const top = candidates[0];
    if (!top || top.score < this.settings.possible) return { decision: 'NO_MATCH', candidates };
    // A POOR-quality face can never produce a STRONG decision.
    const strong = top.score >= this.settings.strong && GRADE_RANK[face.quality.grade] >= GRADE_RANK.FAIR;
    return { decision: strong ? 'STRONG' : 'POSSIBLE', candidates };
  }

  /**
   * Record faces from a camera frame or an evidence item, match them, queue reviews and raise alerts.
   * `context.zoneId`/`position` come from the camera geometry when known.
   */
  async processFaces(
    faces: FaceOut[],
    ctx: { sourceKind: 'camera' | 'evidence'; sourceId: string; t: number; tMedia: number | null; zoneId?: string | null; position?: Vec3 | null; sourceLabel: string },
  ): Promise<FaceEventRecord[]> {
    const out: FaceEventRecord[] = [];
    for (const f of faces) {
      const { decision, candidates } = this.decide(f);
      const top = candidates[0];
      const ident = top ? this.identities.get(top.identityId) : undefined;
      const matched = decision === 'STRONG' || decision === 'POSSIBLE';
      // Re-sighting window: the same recognised person at the same camera within 10 minutes is one sighting
      // (a person waiting at a door must not fill the review queue). A stronger decision is still recorded.
      if (matched && ident && ctx.sourceKind === 'camera') {
        const key = `${ident.id}:${ctx.sourceId}`;
        const prev = this.recentSightings.get(key);
        const rank = decision === 'STRONG' ? 2 : 1;
        if (prev && ctx.t - prev.t < RESIGHT_MS && rank <= prev.rank) {
          prev.t = ctx.t;
          continue;
        }
        this.recentSightings.set(key, { t: ctx.t, rank });
        if (this.recentSightings.size > 5000) this.recentSightings.clear();
      }
      const zone = ctx.zoneId ? FACILITY.zones.find((z) => z.id === ctx.zoneId) : undefined;
      let reviewStatus: FaceEventRecord['reviewStatus'] = 'NOT_REQUIRED';
      if (matched && ident?.list === 'WATCHLIST') reviewStatus = 'PENDING';
      else if (decision === 'POSSIBLE') reviewStatus = 'PENDING';
      const crop = await this.store.put('faces/seen', f.crop);
      const aligned = await this.store.put('faces/seen', f.aligned);
      const id = `fce-${randomUUID().slice(0, 10)}`;
      const ev: EvidenceRef[] = [{ kind: 'face_event', id, sensorId: ctx.sourceKind === 'camera' ? ctx.sourceId : undefined, t: ctx.t, state: 'INFERRED', note: `${decision}${top ? ` ${top.name} ${top.score.toFixed(2)}` : ''} · quality ${f.quality.grade}` }];
      if (ctx.sourceKind === 'evidence') ev.push({ kind: 'evidence_item', id: ctx.sourceId, state: 'CAPTURED' });
      let alertId: string | null = null;
      if (matched && ident?.list === 'WATCHLIST') {
        const priority = decision === 'STRONG' ? (ident.threatLevel === 'HIGH' ? 'critical' : 'high') : 'medium';
        const a = await this.alerts.raise({
          rule: 'WATCHLIST_CANDIDATE',
          dedupeKey: `wl:${ident.id}:${ctx.sourceId}`,
          priority,
          title: `${decision === 'STRONG' ? 'Watchlist match' : 'Possible watchlist match'}: ${ident.name} (${top!.score.toFixed(2)}) — ${ctx.sourceLabel}. Human verification required.`,
          source: ctx.sourceId,
          position: ctx.position ?? null,
          t: ctx.t,
          evidence: ev,
        });
        alertId = a.id;
      } else if (matched && ident?.list === 'AUTHORISED' && decision === 'STRONG' && zone?.restricted && !ident.accessZones.includes(zone.id) && ctx.sourceKind === 'camera') {
        const a = await this.alerts.raise({
          rule: 'UNAUTHORISED_ZONE_ACCESS',
          dedupeKey: `za:${ident.id}:${zone.id}`,
          priority: 'high',
          title: `${ident.rank ? `${ident.rank} ` : ''}${ident.name} recognised in ${zone.name} without access authorisation (${ctx.sourceLabel})`,
          source: ctx.sourceId,
          position: ctx.position ?? null,
          t: ctx.t,
          evidence: ev,
        });
        alertId = a.id;
      } else if (decision === 'NO_MATCH' && zone?.restricted && ctx.sourceKind === 'camera' && this.settings.alertUnknownInRestricted && GRADE_RANK[f.quality.grade] >= GRADE_RANK.FAIR) {
        const a = await this.alerts.raise({
          rule: 'UNKNOWN_PERSON_RESTRICTED',
          dedupeKey: `unk:${zone.id}:${ctx.sourceId}`,
          priority: 'medium',
          title: `Unrecognised person in ${zone.name} (${ctx.sourceLabel}) — not in the authorised register`,
          source: ctx.sourceId,
          position: ctx.position ?? null,
          t: ctx.t,
          evidence: ev,
        });
        alertId = a.id;
      }
      await this.db.query(
        `INSERT INTO face_events (id, t, source_kind, source_id, t_media, box, quality, embedding, crop_key, aligned_key, encrypted, best_identity_id, best_score, candidates, decision, review_status, zone_id, alert_id, x, y)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20)`,
        [
          id,
          ctx.t,
          ctx.sourceKind,
          ctx.sourceId,
          ctx.tMedia,
          JSON.stringify(f.box),
          JSON.stringify(f.quality),
          f.embedding ? JSON.stringify(f.embedding) : null,
          crop.key,
          aligned.key,
          crop.encrypted,
          top?.identityId ?? null,
          top?.score ?? null,
          JSON.stringify(candidates.slice(0, 3)),
          decision,
          reviewStatus,
          zone?.id ?? null,
          alertId,
          ctx.position?.x ?? null,
          ctx.position?.y ?? null,
        ],
      );
      const rec = (await this.getFaceEvent(id))!;
      out.push(rec);
      if (reviewStatus === 'PENDING' || alertId) this.hub.publish({ type: 'face_event', event: rec });
    }
    return out;
  }

  async getFaceEvent(id: string): Promise<FaceEventRecord | null> {
    const r = (await this.db.query<FaceEventRow>('SELECT * FROM face_events WHERE id = $1', [id])).rows[0];
    return r ? toFaceEvent(r) : null;
  }

  async faceImage(id: string, which: 'crop' | 'aligned'): Promise<Uint8Array | null> {
    const r = (await this.db.query<{ crop_key: string; aligned_key: string | null; encrypted: boolean }>('SELECT crop_key, aligned_key, encrypted FROM face_events WHERE id = $1', [id])).rows[0];
    if (!r) return null;
    const key = which === 'aligned' && r.aligned_key ? r.aligned_key : r.crop_key;
    return this.store.get(key, r.encrypted);
  }

  async faceEmbedding(id: string): Promise<number[] | null> {
    const r = (await this.db.query<{ embedding: number[] | null }>('SELECT embedding FROM face_events WHERE id = $1', [id])).rows[0];
    return r?.embedding ?? null;
  }

  async listFaceEvents(o: { review?: FaceEventRecord['reviewStatus']; identityId?: string; sourceId?: string; decision?: FaceEventRecord['decision']; from?: number; to?: number; limit: number }): Promise<FaceEventRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (o.review) add('review_status = ?', o.review);
    if (o.identityId) add('best_identity_id = ?', o.identityId);
    if (o.sourceId) add('source_id = ?', o.sourceId);
    if (o.decision) add('decision = ?', o.decision);
    if (o.from) add('t >= ?::bigint', o.from);
    if (o.to) add('t <= ?::bigint', o.to);
    params.push(o.limit);
    return (await this.db.query<FaceEventRow>(`SELECT * FROM face_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t DESC, id LIMIT $${params.length}`, params)).rows.map(toFaceEvent);
  }

  async review(id: string, decision: 'CONFIRMED' | 'REJECTED', note: string, by: string, identityId?: string): Promise<FaceEventRecord> {
    const ev = await this.getFaceEvent(id);
    if (!ev) throw new IdentityError('unknown face event');
    const ident = identityId ?? ev.bestIdentityId;
    await this.db.query('UPDATE face_events SET review_status = $2, reviewed_by = $3, reviewed_at = $4, review_note = $5, best_identity_id = $6 WHERE id = $1', [id, decision, by, Date.now(), note, ident]);
    if (ev.alertId) {
      const name = ident ? (this.identities.get(ident)?.name ?? ident) : 'candidate';
      await this.alerts.addNote(ev.alertId, by, decision === 'CONFIRMED' ? `Identity CONFIRMED by ${by}: ${name}. ${note}` : `Candidate REJECTED by ${by} (not ${name}). ${note}`);
    }
    const rec = (await this.getFaceEvent(id))!;
    this.hub.publish({ type: 'face_event', event: rec });
    return rec;
  }

  /**
   * Retrospective search: every stored face sighting similar to `embedding`, newest first within score.
   * Scans in pages so memory stays bounded on large archives.
   */
  async search(embedding: ArrayLike<number>, o: { minScore: number; from?: number; to?: number; limit: number }): Promise<(FaceEventRecord & { score: number })[]> {
    const res: (FaceEventRow & { score: number })[] = [];
    let last = '';
    let lastT = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const rows = (
        await this.db.query<FaceEventRow & { embedding: number[] | null }>(
          `SELECT * FROM face_events WHERE embedding IS NOT NULL AND (t < $1::bigint OR (t = $1::bigint AND id > $2)) AND t >= $3::bigint AND t <= $4::bigint ORDER BY t DESC, id LIMIT 2000`,
          [lastT, last, o.from ?? 0, o.to ?? Number.MAX_SAFE_INTEGER],
        )
      ).rows;
      if (!rows.length) break;
      for (const r of rows) {
        const s = cosine(embedding, r.embedding!);
        if (s >= o.minScore) res.push({ ...r, score: Math.round(s * 1000) / 1000 });
      }
      const tail = rows[rows.length - 1]!;
      lastT = tail.t;
      last = tail.id;
      if (rows.length < 2000) break;
    }
    return res
      .sort((a, b) => b.score - a.score)
      .slice(0, o.limit)
      .map((r) => ({ ...toFaceEvent(r), score: r.score }));
  }

  /** Delete unmatched, unreviewed sightings older than the retention period (images included). */
  async purge(now = Date.now()): Promise<number> {
    const cutoff = now - this.settings.retentionDays * 86_400_000;
    const rows = (await this.db.query<{ id: string; crop_key: string; aligned_key: string | null }>(`SELECT id, crop_key, aligned_key FROM face_events WHERE t < $1::bigint AND decision IN ('NO_MATCH','NOT_COMPARABLE') AND review_status = 'NOT_REQUIRED' AND alert_id IS NULL LIMIT 5000`, [cutoff])).rows;
    for (const r of rows) {
      await this.store.remove(r.crop_key);
      if (r.aligned_key) await this.store.remove(r.aligned_key);
    }
    if (rows.length) await this.db.query(`DELETE FROM face_events WHERE id = ANY($1::text[])`, [rows.map((r) => r.id)]);
    return rows.length;
  }

  async counts(): Promise<{ pendingReview: number; sightings24h: number; matches24h: number }> {
    const since = Date.now() - 86_400_000;
    const r = (await this.db.query<{ p: number; s: number; m: number }>(`SELECT (SELECT count(*)::int FROM face_events WHERE review_status = 'PENDING') AS p, (SELECT count(*)::int FROM face_events WHERE t >= $1::bigint) AS s, (SELECT count(*)::int FROM face_events WHERE t >= $1::bigint AND decision IN ('STRONG','POSSIBLE')) AS m`, [since])).rows[0]!;
    return { pendingReview: r.p, sightings24h: r.s, matches24h: r.m };
  }
}
