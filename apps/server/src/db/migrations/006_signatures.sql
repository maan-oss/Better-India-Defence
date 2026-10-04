-- Signed watch handover: the incoming officer's drawn signature (PNG data URL) and its SHA-256.
ALTER TABLE handovers ADD COLUMN IF NOT EXISTS signature TEXT;
ALTER TABLE handovers ADD COLUMN IF NOT EXISTS signature_sha256 TEXT;
CREATE INDEX IF NOT EXISTS log_entries_ref_idx ON log_entries (ref);
