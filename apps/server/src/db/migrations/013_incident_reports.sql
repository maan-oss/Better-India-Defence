-- Incident reports: reported, verified, escalated, responding, resolved and reviewed. Linked equipment, and an
-- append-only history of every step (a database trigger refuses changes to it).
CREATE TABLE incident_reports (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('intrusion', 'power', 'fire', 'medical', 'access', 'cyber', 'other')),
  description text NOT NULL,
  state text NOT NULL CHECK (state IN ('reported', 'verified', 'escalated', 'responding', 'resolved', 'reviewed')),
  classification text NOT NULL DEFAULT 'UNCLASSIFIED' CHECK (classification IN ('UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET')),
  owner text NOT NULL CHECK (owner ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  reported_by text NOT NULL,
  reported_at bigint NOT NULL,
  verified_by text,
  verified_at bigint,
  resolved_by text,
  resolved_at bigint,
  resolution text,
  reviewed_by text,
  reviewed_at bigint,
  review_summary text,
  lessons text
);

CREATE TABLE incident_report_assets (
  report_id text NOT NULL REFERENCES incident_reports(id),
  asset_id text NOT NULL REFERENCES assets(id),
  linked_by text NOT NULL,
  linked_at bigint NOT NULL,
  PRIMARY KEY (report_id, asset_id)
);

CREATE TABLE incident_report_events (
  id bigserial PRIMARY KEY,
  report_id text NOT NULL REFERENCES incident_reports(id),
  t bigint NOT NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL
);
CREATE INDEX incident_report_events_report ON incident_report_events (report_id, id);

CREATE FUNCTION incident_report_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'incident_report_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER incident_report_events_no_update BEFORE UPDATE OR DELETE ON incident_report_events
  FOR EACH ROW EXECUTE FUNCTION incident_report_events_immutable();
