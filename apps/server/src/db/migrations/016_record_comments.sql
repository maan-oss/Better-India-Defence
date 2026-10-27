-- Comments on a record: one append-only thread per incident report or asset. A comment is visible to whoever can see
-- the record it is on, and nothing is edited or removed, so a note someone relied on is still there.
CREATE TABLE record_comments (
  id bigserial PRIMARY KEY,
  record_kind text NOT NULL CHECK (record_kind IN ('incident_report', 'asset')),
  record_id text NOT NULL,
  author text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at bigint NOT NULL
);
CREATE INDEX record_comments_record ON record_comments (record_kind, record_id, id);

CREATE FUNCTION record_comments_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'record_comments is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER record_comments_no_update BEFORE UPDATE OR DELETE ON record_comments
  FOR EACH ROW EXECUTE FUNCTION record_comments_immutable();
