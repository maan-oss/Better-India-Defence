-- Second factor (TOTP, RFC 6238). The secret is sealed with the storage key; totp_last_step is the last accepted time
-- step, so a code cannot be used twice. A session created before the factor is enrolled is marked not verified: the
-- server refuses everything but the enrolment routes until the factor is set up.
ALTER TABLE users ADD COLUMN totp_secret text;
ALTER TABLE users ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN totp_last_step bigint NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN mfa_verified boolean NOT NULL DEFAULT true;

-- A password has been accepted and a code is awaited. Single use; expires quickly.
CREATE TABLE mfa_challenges (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL
);
