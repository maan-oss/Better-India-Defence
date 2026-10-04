-- Strata core schema. Times are epoch milliseconds (bigint, UTC). Positions are local ENU metres
-- relative to the facility origin; geodetic lon/lat is retained where the source provided it.

CREATE TABLE facilities (
  id text PRIMARY KEY,
  name text NOT NULL,
  origin_lat double precision NOT NULL,
  origin_lon double precision NOT NULL,
  origin_alt double precision NOT NULL,
  half_extent_m double precision NOT NULL,
  definition jsonb NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE zones (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id),
  name text NOT NULL,
  kind text NOT NULL,
  restricted boolean NOT NULL,
  polygon jsonb NOT NULL
);

CREATE TABLE sensors (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id),
  kind text NOT NULL,
  name text NOT NULL,
  segment text NOT NULL,
  definition jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  registered_at bigint NOT NULL
);

-- Latest status per sensor (derived) and an append-only transition history.
CREATE TABLE sensor_status (
  sensor_id text PRIMARY KEY REFERENCES sensors(id),
  status text NOT NULL,
  last_seen bigint,
  last_seq bigint,
  message text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at bigint NOT NULL
);

CREATE TABLE sensor_status_events (
  id bigserial PRIMARY KEY,
  sensor_id text NOT NULL REFERENCES sensors(id),
  t bigint NOT NULL,
  status text NOT NULL,
  previous text,
  message text
);
CREATE INDEX sensor_status_events_t ON sensor_status_events (t);
CREATE INDEX sensor_status_events_sensor_t ON sensor_status_events (sensor_id, t);

-- Every normalised observation, with provenance back to the wire message.
CREATE TABLE observations (
  id text PRIMARY KEY,
  message_id text NOT NULL,
  sensor_id text NOT NULL,
  kind text NOT NULL,
  source_kind text NOT NULL,
  t bigint NOT NULL,
  received_at bigint NOT NULL,
  ingest_seq bigint NOT NULL,
  x double precision,
  y double precision,
  z double precision,
  lat double precision,
  lon double precision,
  sx double precision,
  sy double precision,
  sz double precision,
  vx double precision,
  vy double precision,
  vz double precision,
  state text NOT NULL,
  quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL,
  adapter text NOT NULL,
  seq bigint NOT NULL
);
CREATE INDEX observations_t ON observations (t);
CREATE INDEX observations_sensor_t ON observations (sensor_id, t);
CREATE INDEX observations_kind_t ON observations (kind, t);
CREATE INDEX observations_message ON observations (message_id);
CREATE INDEX observations_xy ON observations (x, y) WHERE x IS NOT NULL;

CREATE TABLE ingest_messages (
  message_id text PRIMARY KEY,
  sensor_id text NOT NULL,
  received_at bigint NOT NULL
);

CREATE TABLE dead_letters (
  id bigserial PRIMARY KEY,
  received_at bigint NOT NULL,
  reason text NOT NULL,
  sensor_id text,
  message_id text,
  raw text NOT NULL
);
CREATE INDEX dead_letters_received ON dead_letters (received_at);

CREATE TABLE media_assets (
  id text PRIMARY KEY,
  sensor_id text,
  kind text NOT NULL,
  captured_at bigint NOT NULL,
  content_type text NOT NULL,
  bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  width integer,
  height integer,
  encrypted boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at bigint NOT NULL
);
CREATE INDEX media_assets_sensor_t ON media_assets (sensor_id, captured_at);
CREATE INDEX media_assets_kind_t ON media_assets (kind, captured_at);

CREATE TABLE tracks (
  id text PRIMARY KEY,
  category text NOT NULL,
  label text NOT NULL,
  entity_id text,
  cooperative boolean NOT NULL,
  classification text NOT NULL,
  first_t bigint NOT NULL,
  last_t bigint NOT NULL,
  status text NOT NULL,
  max_confidence double precision NOT NULL,
  contributors jsonb NOT NULL DEFAULT '[]'::jsonb,
  merged_into text
);
CREATE INDEX tracks_last_t ON tracks (last_t);

CREATE TABLE track_states (
  id bigserial PRIMARY KEY,
  track_id text NOT NULL,
  t bigint NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  z double precision NOT NULL,
  vx double precision NOT NULL,
  vy double precision NOT NULL,
  vz double precision NOT NULL,
  sigma_h double precision NOT NULL,
  sigma_v double precision NOT NULL,
  status text NOT NULL,
  confidence double precision NOT NULL,
  classification text NOT NULL,
  state text NOT NULL,
  contributors text[] NOT NULL,
  observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX track_states_t ON track_states (t);
CREATE INDEX track_states_track_t ON track_states (track_id, t);

-- World memory: physical structure versions with validity intervals (temporal geometry).
CREATE TABLE spatial_assets (
  id text PRIMARY KEY,
  asset_key text NOT NULL,
  version integer NOT NULL,
  kind text NOT NULL,
  label text NOT NULL,
  geometry jsonb NOT NULL,
  valid_from bigint NOT NULL,
  valid_to bigint,
  state text NOT NULL,
  confidence double precision NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  reconstruction_id text,
  UNIQUE (asset_key, version)
);
CREATE INDEX spatial_assets_key ON spatial_assets (asset_key, valid_from);

-- Static objects known to world memory (expected objects + objects discovered by sensors).
CREATE TABLE world_objects (
  id text PRIMARY KEY,
  kind text NOT NULL,
  label text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  z double precision NOT NULL,
  extent_m double precision NOT NULL,
  yaw_deg double precision NOT NULL DEFAULT 0,
  valid_from bigint NOT NULL,
  valid_to bigint,
  state text NOT NULL,
  source text NOT NULL,
  last_confirmed_at bigint,
  confirmations integer NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX world_objects_valid ON world_objects (valid_from, valid_to);

CREATE TABLE infrastructure_states (
  id bigserial PRIMARY KEY,
  asset_id text NOT NULL,
  asset_kind text NOT NULL,
  t bigint NOT NULL,
  state text NOT NULL,
  alarm boolean NOT NULL,
  detail text,
  observation_id text
);
CREATE INDEX infrastructure_states_asset_t ON infrastructure_states (asset_id, t);
CREATE INDEX infrastructure_states_t ON infrastructure_states (t);

CREATE TABLE world_changes (
  id text PRIMARY KEY,
  t bigint NOT NULL,
  kind text NOT NULL,
  subject_id text NOT NULL,
  title text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  z double precision NOT NULL,
  extent_m double precision NOT NULL,
  magnitude double precision NOT NULL,
  confidence double precision NOT NULL,
  state text NOT NULL,
  detector text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX world_changes_t ON world_changes (t);

CREATE TABLE world_snapshots (
  id text PRIMARY KEY,
  t bigint NOT NULL,
  summary jsonb NOT NULL
);
CREATE INDEX world_snapshots_t ON world_snapshots (t);

CREATE TABLE lidar_scans (
  id text PRIMARY KEY,
  sensor_id text NOT NULL,
  t bigint NOT NULL,
  media_id text NOT NULL,
  observation_id text NOT NULL,
  origin jsonb NOT NULL,
  stats jsonb NOT NULL,
  patch_support jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX lidar_scans_t ON lidar_scans (t);

CREATE TABLE imagery_captures (
  id text PRIMARY KEY,
  sensor_id text NOT NULL,
  acquired_at bigint NOT NULL,
  received_at bigint NOT NULL,
  media_id text NOT NULL,
  gsd_m double precision NOT NULL,
  cloud_cover_pct double precision NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  observation_id text NOT NULL,
  footprint jsonb NOT NULL
);
CREATE INDEX imagery_captures_t ON imagery_captures (acquired_at);

CREATE TABLE reconstructions (
  id text PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL,
  title text NOT NULL,
  requested_by text NOT NULL,
  created_at bigint NOT NULL,
  started_at bigint,
  finished_at bigint,
  params jsonb NOT NULL,
  inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb,
  confidence double precision,
  error text
);
CREATE INDEX reconstructions_created ON reconstructions (created_at);

CREATE TABLE alerts (
  id text PRIMARY KEY,
  t bigint NOT NULL,
  priority text NOT NULL,
  rule text NOT NULL,
  dedupe_key text NOT NULL,
  title text NOT NULL,
  source text NOT NULL,
  x double precision,
  y double precision,
  z double precision,
  status text NOT NULL,
  assigned_to text,
  track_id text,
  incident_id text,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ack_by text,
  ack_at bigint,
  updated_at bigint NOT NULL
);
CREATE INDEX alerts_t ON alerts (t);
CREATE INDEX alerts_dedupe ON alerts (dedupe_key, status);

CREATE TABLE incidents (
  id text PRIMARY KEY,
  code text UNIQUE NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  t_start bigint NOT NULL,
  t_end bigint NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  z double precision NOT NULL,
  radius_m double precision NOT NULL,
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  summary text NOT NULL DEFAULT '',
  alert_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE test_subjects (
  id text PRIMARY KEY,
  label text NOT NULL,
  consent_ref text NOT NULL,
  synthetic boolean NOT NULL,
  reference_descriptor jsonb NOT NULL,
  enrolled_at bigint NOT NULL,
  enrolled_by text NOT NULL,
  notes text NOT NULL DEFAULT ''
);

CREATE TABLE users (
  id text PRIMARY KEY,
  username text UNIQUE NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL,
  password_hash text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  ip text
);

CREATE TABLE config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at bigint NOT NULL
);

-- Append-only, hash-chained audit log. UPDATE/DELETE are rejected by trigger.
CREATE TABLE audit_events (
  seq bigserial PRIMARY KEY,
  t bigint NOT NULL,
  actor text NOT NULL,
  role text NOT NULL,
  action text NOT NULL,
  target text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  prev_hash text NOT NULL,
  hash text NOT NULL
);
CREATE INDEX audit_events_t ON audit_events (t);
CREATE INDEX audit_events_action ON audit_events (action, t);

CREATE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TABLE simulation_scenarios (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  duration_min double precision NOT NULL,
  exercises jsonb NOT NULL
);

CREATE TABLE system_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
