-- Login failures per username, kept in the database so a lockout survives a restart and holds across instances.
-- locked_until is 0 when the username is not locked; failures resets when a lock has expired.
CREATE TABLE login_lockouts (
  username text PRIMARY KEY,
  failures integer NOT NULL,
  locked_until bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);
