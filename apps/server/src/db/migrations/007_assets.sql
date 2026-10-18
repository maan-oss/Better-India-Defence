-- Asset and infrastructure register: equipment, the dependencies between assets, recurring maintenance plans and an
-- append-only history of every change. Assets are retired, never deleted, so their history stays complete.

CREATE TABLE assets (
  id text PRIMARY KEY,
  tag text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'in_service' CHECK (status IN ('in_service', 'degraded', 'out_of_service', 'retired')),
  criticality integer NOT NULL CHECK (criticality BETWEEN 1 AND 5),
  zone_id text,
  manufacturer text,
  model text,
  serial text,
  commissioned_at bigint,
  warranty_until bigint,
  notes text,
  source text NOT NULL DEFAULT 'operator' CHECK (source IN ('operator', 'demo')),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX assets_criticality ON assets (criticality DESC, tag);

-- "asset_id needs depends_on_id to operate". A self-edge is refused here; loops are refused by the service.
CREATE TABLE asset_dependencies (
  asset_id text NOT NULL REFERENCES assets(id),
  depends_on_id text NOT NULL REFERENCES assets(id),
  kind text NOT NULL,
  PRIMARY KEY (asset_id, depends_on_id),
  CHECK (asset_id <> depends_on_id)
);
CREATE INDEX asset_dependencies_upstream ON asset_dependencies (depends_on_id);

CREATE TABLE maintenance_plans (
  id text PRIMARY KEY,
  asset_id text NOT NULL REFERENCES assets(id),
  title text NOT NULL,
  interval_days integer NOT NULL CHECK (interval_days BETWEEN 1 AND 3650),
  last_done_at bigint,
  created_by text NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX maintenance_plans_asset ON maintenance_plans (asset_id);

CREATE TABLE asset_events (
  id bigserial PRIMARY KEY,
  asset_id text NOT NULL REFERENCES assets(id),
  t bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('created', 'edited', 'status', 'dependencies', 'maintenance', 'retired')),
  detail jsonb NOT NULL,
  actor text NOT NULL
);
CREATE INDEX asset_events_asset ON asset_events (asset_id, t);

-- Append-only, like audit_events: UPDATE and DELETE are rejected by trigger.
CREATE FUNCTION asset_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'asset_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER asset_events_no_update BEFORE UPDATE OR DELETE ON asset_events
  FOR EACH ROW EXECUTE FUNCTION asset_events_immutable();
