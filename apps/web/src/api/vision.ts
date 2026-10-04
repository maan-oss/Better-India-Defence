import { create } from 'zustand';
import type { FaceEventSummary, LiveMessage } from '@strata/domain';
import type { EnhanceOp, ImageStats, ProductState } from '@strata/domain/vision';
import { get } from './client';

/** Client-side shapes of the vision / evidence / identity API (mirrors apps/server responses). */
export type { EnhanceOp, ProductState };

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceQuality {
  interOcularPx: number;
  yawDeg: number;
  sharpness: number;
  detectorScore: number;
  grade: 'GOOD' | 'FAIR' | 'POOR' | 'UNUSABLE';
  reasons: string[];
}

export interface AnalysisSummary {
  mode: 'standard' | 'thorough';
  framesAnalysed: number;
  sampleFps: number | null;
  objectCounts: Record<string, number>;
  maxPersonsInFrame: number;
  maxVehiclesInFrame: number;
  faceAppearances: number;
  watchlistCandidates: number;
  authorisedMatches: number;
  timeline: { t: number; persons: number; vehicles: number; faces: number }[];
  stats?: ImageStats;
  ms: number;
}

export interface EvidenceItem {
  id: string;
  kind: 'image' | 'video';
  title: string;
  originalName: string | null;
  sha256: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationS: number | null;
  fps: number | null;
  source: string;
  capturedAt: number | null;
  capturedAtBasis: string | null;
  lat: number | null;
  lon: number | null;
  incidentId: string | null;
  classification: string;
  notes: string | null;
  uploadedBy: string;
  uploadedAt: number;
  analysisStatus: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  analysisError: string | null;
  analysis: Partial<AnalysisSummary>;
}

export interface ProductStep {
  op: string | { op: string; [k: string]: unknown };
  description: string;
  state?: ProductState;
  ms?: number;
  sha256After?: string;
  sha256?: string;
  itemSha256?: string;
  roi?: Box;
  shifts?: { dx: number; dy: number }[];
}

export interface EvidenceProduct {
  id: string;
  itemId: string;
  kind: 'enhancement' | 'multi_frame' | 'frame';
  frameT: number | null;
  state: ProductState;
  steps: ProductStep[];
  sha256In: string;
  sha256Out: string;
  width: number;
  height: number;
  createdBy: string;
  createdAt: number;
  notes: string | null;
  usedFrames?: number;
  rejectedFrames?: number;
}

export interface MediaDetection {
  tS: number | null;
  kind: 'object' | 'face';
  label: string;
  category: string | null;
  score: number;
  box: Box;
  quality: FaceQuality | null;
}

export interface Candidate {
  identityId: string;
  name: string;
  list: 'AUTHORISED' | 'WATCHLIST';
  score: number;
  templateId: string;
}

export interface FaceEvent {
  id: string;
  t: number;
  sourceKind: 'camera' | 'evidence';
  sourceId: string;
  tMedia: number | null;
  box: Box;
  quality: FaceQuality;
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
  score?: number;
}

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

export interface IdentityDetail extends Identity {
  templates: number;
  templatesList?: never;
}

export interface Template {
  id: string;
  quality: FaceQuality;
  source: string;
  createdBy: string;
  createdAt: number;
}

export interface PhotoFaces {
  token: string;
  sha256: string;
  width: number;
  height: number;
  faces: { index: number; box: Box; quality: FaceQuality; usable: boolean; crop: string; matches: Candidate[] }[];
}

export interface FaceSettings {
  strong: number;
  possible: number;
  minGrade: 'GOOD' | 'FAIR' | 'POOR';
  retentionDays: number;
  alertUnknownInRestricted: boolean;
}

export interface VisionStatus {
  models: { key: string; name: string; licence: string; purpose: string; installed: boolean; verified: boolean; loaded: boolean; error: string | null; sha256: string }[];
  ffmpeg: boolean;
  queue: { interactive: number; bulk: number; busy: number };
  gallery: { identities: number; templates: number; watchlist: number; authorised: number };
  settings: FaceSettings;
}

export const STATE_LABEL: Record<ProductState, string> = {
  ORIGINAL: 'Original pixels',
  RESTORED: 'Restored (deterministic)',
  'MULTI-OBSERVATION': 'Multi-frame fusion',
  'AI-INFERRED': 'AI-inferred — not evidence',
};

export const STATE_HELP_PRODUCT: Record<ProductState, string> = {
  ORIGINAL: 'Pixels exactly as captured (or a lossless crop / frame extraction).',
  RESTORED: 'Deterministic, documented operators applied to the captured pixels. No information added; everything shown was in the source.',
  'MULTI-OBSERVATION': 'Several registered frames of the same scene combined. Real additional information from independent samples, within the limits stated.',
  'AI-INFERRED': 'A neural network predicted detail from patterns learned on other images. May be invented. Never use for identification or as proof.',
};

/** Upload with progress (fetch has no upload progress events). */
export function uploadEvidence(file: File, meta: Record<string, string>, onProgress: (f: number) => void): Promise<{ item: EvidenceItem; duplicate: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const q = new URLSearchParams({ ...meta, originalName: file.name }).toString();
    xhr.open('POST', `/api/evidence/items?${q}`);
    xhr.setRequestHeader('content-type', 'application/x-strata-upload');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as { item: EvidenceItem; duplicate: boolean });
      else reject(new Error((body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null) ?? `upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('network error during upload'));
    xhr.send(file);
  });
}

export async function analysePhoto(file: Blob): Promise<PhotoFaces> {
  const res = await fetch('/api/vision/faces', { method: 'POST', body: file, credentials: 'same-origin', headers: { 'content-type': file.type === 'image/png' ? 'image/png' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg' } });
  const body = (await res.json()) as PhotoFaces | { error: string };
  if (!res.ok) throw new Error('error' in body ? body.error : `analysis failed (${res.status})`);
  return body as PhotoFaces;
}

/** Live counters for evidence processing and recognition (drives badges and auto-refresh). */
interface VisionLive {
  evidenceStatus: Record<string, string>;
  evidenceVersion: number;
  faceVersion: number;
  pendingReview: number;
  lastFace: FaceEventSummary | null;
  onLive(m: LiveMessage): void;
  refreshCounts(): Promise<void>;
}

export const useVisionLive = create<VisionLive>((set, getS) => ({
  evidenceStatus: {},
  evidenceVersion: 0,
  faceVersion: 0,
  pendingReview: 0,
  lastFace: null,
  onLive(m) {
    if (m.type === 'evidence') set({ evidenceStatus: { ...getS().evidenceStatus, [m.id]: m.status }, evidenceVersion: getS().evidenceVersion + (m.status.startsWith('running') ? 0 : 1) });
    else if (m.type === 'face_event') {
      set({ faceVersion: getS().faceVersion + 1, lastFace: m.event });
      void getS().refreshCounts();
    }
  },
  async refreshCounts() {
    try {
      const pending = await get<FaceEvent[]>('/api/faces?review=PENDING&limit=500');
      set({ pendingReview: pending.length });
    } catch {
      /* role may lack identity.view */
    }
  },
}));
