-- Stock on the dependency graph. A supply item carries a quantity and a reorder level; a quantity of zero is a stock-out
-- and impairs what depends on it. A reorder is requested by one person and takes effect only when another approves it.
ALTER TABLE assets ADD COLUMN stock_quantity double precision;
ALTER TABLE assets ADD COLUMN reorder_level double precision;
ALTER TABLE assets ADD COLUMN stock_unit text;

CREATE TABLE reorder_requests (
  id text PRIMARY KEY,
  asset_id text NOT NULL REFERENCES assets(id),
  quantity double precision NOT NULL CHECK (quantity > 0),
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('requested', 'approved', 'rejected')),
  requested_by text NOT NULL,
  requested_at bigint NOT NULL,
  decided_by text,
  decided_at bigint,
  decision_note text
);
CREATE INDEX reorder_requests_asset ON reorder_requests (asset_id, requested_at);

-- The history gains the stock and reorder events. The check constraint names the kinds the service writes.
ALTER TABLE asset_events DROP CONSTRAINT asset_events_kind_check;
ALTER TABLE asset_events ADD CONSTRAINT asset_events_kind_check CHECK (kind IN (
  'created', 'edited', 'status', 'dependencies', 'maintenance', 'retired',
  'stock_received', 'stock_issued', 'reorder_requested', 'reorder_approved', 'reorder_rejected'
));
