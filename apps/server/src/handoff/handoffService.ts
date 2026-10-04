import { buildHandoff, appearanceScore, type HandoffObservation, type HandoffResult } from '@strata/domain';
import type { Db } from '../db/client.ts';

export interface TestSubject {
  id: string;
  label: string;
  consentRef: string;
  synthetic: boolean;
  enrolledAt: number;
  enrolledBy: string;
  notes: string;
}

/**
 * Identity hand-off demonstration restricted to enrolled, consenting/synthetic test subjects.
 * The platform holds an enrolment descriptor per test subject and searches recorded camera observations
 * for candidate appearances. There is no open-ended "search any person" capability.
 */
export class HandoffService {
  constructor(private readonly db: Db) {}

  async subjects(): Promise<TestSubject[]> {
    return (await this.db.query<{ id: string; label: string; consent_ref: string; synthetic: boolean; enrolled_at: number; enrolled_by: string; notes: string }>('SELECT id, label, consent_ref, synthetic, enrolled_at, enrolled_by, notes FROM test_subjects ORDER BY label')).rows.map((r) => ({
      id: r.id,
      label: r.label,
      consentRef: r.consent_ref,
      synthetic: r.synthetic,
      enrolledAt: r.enrolled_at,
      enrolledBy: r.enrolled_by,
      notes: r.notes,
    }));
  }

  async enroll(s: { id: string; label: string; consentRef: string; synthetic: boolean; descriptor: number[]; notes: string }, by: string): Promise<void> {
    if (!s.synthetic && !s.consentRef) throw new Error('non-synthetic subjects require a consent reference');
    await this.db.query(
      `INSERT INTO test_subjects (id, label, consent_ref, synthetic, reference_descriptor, enrolled_at, enrolled_by, notes) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, consent_ref=EXCLUDED.consent_ref, reference_descriptor=EXCLUDED.reference_descriptor, notes=EXCLUDED.notes`,
      [s.id, s.label, s.consentRef, s.synthetic, JSON.stringify(s.descriptor), Date.now(), by, s.notes],
    );
  }

  async search(subjectId: string, from: number, to: number): Promise<{ subject: TestSubject; candidates: number; result: HandoffResult; appearances: { observationId: string; cameraId: string; t: number; score: number; bbox: number[]; sharpness: number; faceQuality: number }[] } | null> {
    const row = (await this.db.query<{ reference_descriptor: number[] }>('SELECT reference_descriptor FROM test_subjects WHERE id = $1', [subjectId])).rows[0];
    const subject = (await this.subjects()).find((s) => s.id === subjectId);
    if (!row || !subject) return null;
    const ref = row.reference_descriptor;
    const obs = (await this.db.query<{ id: string; sensor_id: string; t: number; x: number; y: number; z: number; sx: number; appearance: number[]; sharpness: number; face: number | null; bbox: number[] }>(
      `SELECT id, sensor_id, t, x, y, z, sx, payload->'appearance' AS appearance, (payload->>'sharpness')::float AS sharpness, (payload->>'faceQuality')::float AS face, payload->'bbox' AS bbox
       FROM observations WHERE kind = 'track' AND source_kind = 'camera.detections' AND t BETWEEN $1 AND $2 AND payload->>'cls' = 'person' AND payload ? 'appearance' ORDER BY t`,
      [from, to],
    )).rows;
    const hobs: HandoffObservation[] = obs
      .filter((o) => o.x !== null && Array.isArray(o.appearance))
      .map((o) => ({ observationId: o.id, cameraId: o.sensor_id, t: o.t, position: { x: o.x, y: o.y, z: o.z }, appearance: o.appearance, sharpness: o.sharpness, faceQuality: o.face ?? 0, sigmaM: o.sx ?? 2 }));
    const result = buildHandoff(ref, hobs);
    const appearances = result.links.map((l) => {
      const o = obs.find((x) => x.id === l.observation.observationId)!;
      return { observationId: o.id, cameraId: o.sensor_id, t: o.t, score: Math.round(appearanceScore(ref, o.appearance) * 100) / 100, bbox: o.bbox, sharpness: o.sharpness, faceQuality: o.face ?? 0 };
    });
    return { subject, candidates: hobs.length, result, appearances };
  }
}
