-- Operations: readiness, vital assets, response teams and tasking, duty log (occurrence book), watch
-- handover, SITREPs, alert checklists.

CREATE TABLE readiness_log (
  id bigserial PRIMARY KEY,
  t bigint NOT NULL,
  level text NOT NULL,
  reason text NOT NULL,
  set_by text NOT NULL
);

CREATE TABLE vital_assets (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL,
  priority integer NOT NULL CHECK (priority BETWEEN 1 AND 3),
  x double precision NOT NULL,
  y double precision NOT NULL,
  radius_m double precision NOT NULL,
  zone_id text,
  notes text,
  updated_at bigint NOT NULL
);

CREATE TABLE teams (
  id text PRIMARY KEY,
  callsign text NOT NULL UNIQUE,
  kind text NOT NULL,
  strength integer NOT NULL DEFAULT 1,
  leader text,
  channel text,
  entity_id text,                      -- GPS / cooperative tracker id for live position
  mode text NOT NULL DEFAULT 'foot',   -- foot | vehicle (ETA estimate)
  status text NOT NULL DEFAULT 'AVAILABLE',
  notes text,
  updated_at bigint NOT NULL
);

CREATE TABLE tasks (
  id text PRIMARY KEY,
  number integer NOT NULL,
  team_id text NOT NULL REFERENCES teams(id),
  alert_id text,
  incident_id text,
  x double precision,
  y double precision,
  location_text text,
  orders text NOT NULL,
  priority text NOT NULL DEFAULT 'high',
  status text NOT NULL DEFAULT 'ISSUED',
  eta_s double precision,
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome text,
  closed_at bigint
);
CREATE INDEX tasks_created ON tasks (created_at);
CREATE INDEX tasks_team ON tasks (team_id, status);

CREATE TABLE log_entries (
  id bigserial PRIMARY KEY,
  t bigint NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  author text NOT NULL,
  ref text
);
CREATE INDEX log_entries_t ON log_entries (t);

CREATE FUNCTION log_entries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the duty log is append-only; add a correcting entry instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER log_entries_no_update BEFORE UPDATE OR DELETE ON log_entries
  FOR EACH ROW EXECUTE FUNCTION log_entries_immutable();

CREATE TABLE handovers (
  id text PRIMARY KEY,
  t bigint NOT NULL,
  outgoing text NOT NULL,
  incoming text NOT NULL,
  summary text NOT NULL,
  state jsonb NOT NULL,
  acknowledged_at bigint
);

CREATE TABLE sitreps (
  id text PRIMARY KEY,
  number integer NOT NULL,
  version integer NOT NULL DEFAULT 1,
  incident_id text,
  period_from bigint NOT NULL,
  period_to bigint NOT NULL,
  classification text NOT NULL,
  sections jsonb NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED')),
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  issued_by text,
  issued_at bigint,
  supersedes text
);

CREATE TABLE alert_checklists (
  alert_id text NOT NULL,
  item_index integer NOT NULL,
  item_text text NOT NULL,
  done_by text NOT NULL,
  done_at bigint NOT NULL,
  note text,
  PRIMARY KEY (alert_id, item_index)
);
