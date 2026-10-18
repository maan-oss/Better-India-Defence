-- A sign-in started with an identity provider: the state, nonce and PKCE verifier are kept until the callback arrives.
-- Each row is single use; expired rows are refused.
CREATE TABLE oidc_pending (
  state text PRIMARY KEY,
  nonce text NOT NULL,
  verifier text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL
);
