-- Vision: evidence library (uploaded / captured imagery and video), derived products, identity registry,
-- face sightings and review.

-- Media brought into the system as evidence: uploads (phones, body cams, drone SD cards, external CCTV
-- exports) and frames captured from cameras. Originals are immutable; every derivative is a product.
CREATE TABLE evidence_items (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('image', 'video')),
  title text NOT NULL,
  original_name text,
  mime text,
  object_key text NOT NULL,
  encrypted boolean NOT NULL DEFAULT false,
  sha256 text NOT NULL,
  bytes bigint NOT NULL,
  width integer,
  height integer,
  duration_s double precision,
  fps double precision,
  source text NOT NULL,                -- 'upload' | camera id
  captured_at bigint,                  -- claimed capture time (operator-entered or container metadata)
  captured_at_basis text,              -- how captured_at was established
  lat double precision,
  lon double precision,
  incident_id text,
  classification text NOT NULL DEFAULT 'RESTRICTED',
  notes text,
  uploaded_by text NOT NULL,
  uploaded_at bigint NOT NULL,
  analysis_status text NOT NULL DEFAULT 'pending',   -- pending | running | complete | failed | skipped
  analysis_error text,
  analysis jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX evidence_items_uploaded ON evidence_items (uploaded_at);
CREATE INDEX evidence_items_sha ON evidence_items (sha256);
CREATE INDEX evidence_items_incident ON evidence_items (incident_id);

CREATE TABLE evidence_products (
  id text PRIMARY KEY,
  item_id text NOT NULL REFERENCES evidence_items(id),
  kind text NOT NULL,                  -- enhancement | multi_frame | frame
  frame_t double precision,
  state text NOT NULL CHECK (state IN ('ORIGINAL', 'RESTORED', 'MULTI-OBSERVATION', 'AI-INFERRED')),
  steps jsonb NOT NULL,
  object_key text NOT NULL,
  preview_key text,
  encrypted boolean NOT NULL DEFAULT false,
  sha256_in text NOT NULL,
  sha256_out text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  notes text
);
CREATE INDEX evidence_products_item ON evidence_products (item_id, created_at);

-- Objects and faces found in evidence items (per frame for video).
CREATE TABLE media_detections (
  id bigserial PRIMARY KEY,
  item_id text NOT NULL REFERENCES evidence_items(id),
  t_s double precision,
  kind text NOT NULL CHECK (kind IN ('object', 'face')),
  label text NOT NULL,
  category text,
  score real NOT NULL,
  box jsonb NOT NULL,
  quality jsonb,
  face_event_id text
);
CREATE INDEX media_detections_item ON media_detections (item_id, t_s);

-- Identity registry. AUTHORISED: personnel/contractors permitted on site (with zone access).
-- WATCHLIST: persons of interest; entries require a documented basis and reviewer.
CREATE TABLE identities (
  id text PRIMARY KEY,
  list text NOT NULL CHECK (list IN ('AUTHORISED', 'WATCHLIST')),
  category text NOT NULL,
  name text NOT NULL,
  service_no text,
  rank text,
  unit text,
  organisation text,
  access_zones jsonb NOT NULL DEFAULT '[]'::jsonb,
  threat_level text CHECK (threat_level IS NULL OR threat_level IN ('LOW', 'MEDIUM', 'HIGH')),
  basis text,                          -- why this person is on the watchlist (source / authority)
  notes text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REMOVED')),
  valid_until bigint,
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX identities_list ON identities (list, status);

CREATE TABLE identity_templates (
  id text PRIMARY KEY,
  identity_id text NOT NULL REFERENCES identities(id),
  embedding jsonb NOT NULL,            -- 128 floats, L2-normalised (SFace)
  model text NOT NULL,
  quality jsonb NOT NULL,
  crop_key text NOT NULL,
  aligned_key text NOT NULL,
  encrypted boolean NOT NULL DEFAULT false,
  source text NOT NULL,                -- upload | evidence:<id> | face_event:<id>
  sha256_source text,
  created_by text NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX identity_templates_identity ON identity_templates (identity_id);

-- Every face observed by a live camera or found in evidence media, with the best gallery match.
CREATE TABLE face_events (
  id text PRIMARY KEY,
  t bigint NOT NULL,                   -- wall/observation time
  source_kind text NOT NULL CHECK (source_kind IN ('camera', 'evidence')),
  source_id text NOT NULL,
  t_media double precision,
  box jsonb NOT NULL,
  quality jsonb NOT NULL,
  embedding jsonb,
  crop_key text NOT NULL,
  aligned_key text,
  encrypted boolean NOT NULL DEFAULT false,
  best_identity_id text,
  best_score real,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision text NOT NULL CHECK (decision IN ('STRONG', 'POSSIBLE', 'NO_MATCH', 'NOT_COMPARABLE')),
  review_status text NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (review_status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'NOT_REQUIRED')),
  reviewed_by text,
  reviewed_at bigint,
  review_note text,
  zone_id text,
  alert_id text,
  x double precision,
  y double precision
);
CREATE INDEX face_events_t ON face_events (t);
CREATE INDEX face_events_review ON face_events (review_status, t);
CREATE INDEX face_events_identity ON face_events (best_identity_id, t);
CREATE INDEX face_events_source ON face_events (source_kind, source_id, t);
