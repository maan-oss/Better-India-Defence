# Security architecture

Strata is designed for on-premises, air-gapped deployment. This document describes the controls that
are implemented, how to configure them, and what is **not** done. Strata has **no security
certification or accreditation** of any kind; nothing in this repository should be read as a claim
that it is suitable for classified or regulated use without independent assessment.

## Deployment model

- Single site, on-premises. Runtime needs no internet access: no CDNs, map tiles, web fonts, telemetry
  or licence servers. The only optional outbound call is copilot language routing to the Anthropic API,
  which is disabled unless `ANTHROPIC_API_KEY` is set (`COPILOT_PROVIDER=deterministic` forbids it).
- Processes: API server (also serves the web client), simulator (synthetic data source; replace with
  real sensor adapters), PostgreSQL. All bind to `127.0.0.1` by default; Compose publishes the API on
  loopback only.

## Controls implemented

| Area | Control | Where |
|---|---|---|
| Transport | TLS on the API process (`TLS_CERT_FILE`, `TLS_KEY_FILE`) or a TLS-terminating reverse proxy (`COOKIE_SECURE=true`) | `apps/server/src/app.ts` |
| Authentication | Username/password; a second factor (TOTP, RFC 6238, HMAC-SHA-1, 6 digits, 30 s, one use per step, one-minute and one-step tolerance) required for administrators and analysts in operational mode (`STRATA_MFA_REQUIRED`); the secret is sealed with `STORAGE_ENCRYPTION_KEY`, and a privileged session cannot reach any route except enrolment until a factor is set up; an administrator can remove a lost factor (audited); scrypt (N=2¹⁴, r=8, p=1) with per-user 128-bit salt; constant-time comparison; lockout for 60 s after 5 consecutive failures per username, kept in the database so it survives restarts and holds across instances; unknown usernames count too; a sign-in clears the count; an administrator can release a lock (audited). Passwords an administrator sets (new users, changes, the first administrator from the environment) must be at least 12 characters, not a common word, not containing the account name, and not one repeated character or a simple run | `auth/passwords.ts`, `auth/authService.ts`, `packages/domain/src/auth/password.ts`, migration `008_auth.sql` |
| Single sign-on | Optional OpenID Connect (authorization code with PKCE, state, nonce); ID token signature checked with RS256 against the provider's published keys only, issuer, audience (and azp), expiry and nonce checked; the role comes from a claim through a mapping the installation configures, and a sign-in with no mapped role is refused; the provider's MFA claim (`amr`) is honoured for privileged roles; a disabled local account is refused. Configured with `OIDC_*`; https unless `OIDC_INSECURE_HTTP` | `auth/oidc.ts`, `routes/oidc.ts`, migration `010_oidc.sql` |
| Sessions | 256-bit random opaque tokens; only the SHA-256 is stored; HttpOnly, SameSite=Strict cookie (`Secure` with TLS); configurable TTL; server-side revocation on logout and user disable | `auth/authService.ts` |
| Authorisation | Four roles (viewer < operator < analyst < administrator) mapped to named permissions; every route declares its permission and is checked server-side; the client only hides what the server would refuse | `packages/domain/src/rbac.ts`, `http/guards.ts` |
| Machine access | Sensor adapters authenticate with a service token (`STRATA_SERVICE_TOKEN`) accepted only on `/api/ingest/*`, `/api/interop/cot` and media fetches; ingest only from sensor ids registered for the site | `routes/core.ts`, `routes/interop.ts` |
| Input validation | Every request body/query and every ingest envelope is validated with zod schemas; body size limits; unknown sensors and out-of-bounds timestamps are rejected to a dead-letter table | `schemas/*`, `ingest/pipeline.ts` |
| Rate limiting | Global API limit; stricter login limit (20/min/IP); ingestion exempt (authenticated by token) | `app.ts`, `routes/core.ts` |
| Audit | Append-only `audit_events` table: a database trigger rejects UPDATE/DELETE; each record holds the SHA-256 of its predecessor; `GET /api/audit/verify` recomputes the chain and checks it against the anchor file (`audit/anchor.ts`). Logged: sign-in/out, failed sign-in, timeline and evidence access, alert actions, incident creation/changes/exports, copilot queries, hand-off searches, reconstruction requests, scenario triggers and failure injection, user and configuration changes | `audit/audit.ts`, migration `001_core.sql` |
| Data at rest | Media / object storage encrypted with AES-256-GCM when `STORAGE_ENCRYPTION_KEY` (or `STORAGE_ENCRYPTION_KEY_FILE`) is set. Database encryption at rest is delegated to the host (LUKS/dm-crypt or the database platform) | `storage/objectStore.ts` |
| Key management | Each key is named once and read from the environment or from a file named in `NAME_FILE`, never both. The file must not be readable by other users (POSIX); a key of the wrong length or not in hex stops the start before the database opens. The administrator configuration view reports the source and a 16-hex fingerprint of each key, never the key. Keys covered: `STORAGE_ENCRYPTION_KEY` (32 bytes) and `AUDIT_ANCHOR_KEY` (32 bytes or more). Tested in `keys.test.ts` | `keys/keyring.ts`, `platform.ts` |
| Secrets | From environment variables or from an owner-only file named in `*_FILE` (see Key management below); production mode refuses to start with the development service token; demo mode (shared demo passwords, simulator) cannot run with `NODE_ENV=production`, and demo accounts are never created outside demo mode | `config.ts` |
| First run | With no user accounts, the service issues a one-time 8-character setup code (32-symbol alphabet, about 40 bits) from the OS CSPRNG, logs it and writes it to `<DATA_DIR>/setup-code.txt` (mode 600). The setup endpoints compare it in constant time, are rate-limited (10 per minute), refuse administrator passwords under 12 characters (the wizard also requires a strength rating of at least “fair”), delete the code once the administrator exists, and audit the account creation. Restarting the API from the console requires `admin.config` and is audited | `platform.ts`, `routes/setup.ts` |
| Device cameras and positions | Browser-streamed camera frames and phone positions are accepted only from signed-in users with `ops.log`, for camera sources configured as device cameras and for existing teams; frames must be JPEG (SOI checked), size-limited and rate-limited; positions are range-checked and enter through the same ingest pipeline as any sensor | `routes/cameras.ts`, `routes/ops.ts` |
| Ground imagery | Tile templates must be http(s) XYZ; tiles are fetched by each browser, so the template reveals the site's area to the tile server. The setup wizard warns before choosing a public server (OPSEC); use your own tile server on a closed network | `packages/domain/src/facility/site.ts`, `pages/Setup.tsx` |
| HTTP hardening | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a Content-Security-Policy (scripts and styles from this host only; inline scripts and inline styles refused, see below); generic 500 messages (details only in logs) | `app.ts`, `http/csp.ts` |
| Recovery | Backups carry a manifest of SHA-256 digests; restore refuses a backup whose files changed or whose audit chain does not verify, and refuses a target that is not empty. Procedure and failure table in `RECOVERY.md` | `backup/backup.ts`, `backup/cli.ts`, `routes/backup.ts` |
| Logging | Structured JSON logs (pino); authorization headers, cookies and passwords redacted | `logger.ts` |
| Biometric governance | Recognition only against deliberately enrolled people; watch-list entries require a recorded basis; enrolment, watch list, review and search are analyst-only; searches require a stated purpose; every enrolment, search, review and template change is audited; unmatched sightings purged after a configurable retention period (default 30 days, hourly job); quality gates (UNUSABLE faces never matched, POOR never STRONG); AI-enhanced images never matched; thresholds are settings to be set from the site's own measurements | `identity/identityService.ts`, `routes/vision.ts` |
| Evidence integrity | Uploads streamed to storage with SHA-256 computed on the way in (de-duplicated by hash); every enhancement step records input and output hashes and parameters; evidence reports include the chain of custody from the audit log | `evidence/evidenceService.ts`, `vision/worker.ts` |
| Model integrity | Vision models pinned by SHA-256 in the manifest shipped with the code; verified at download and again before loading; a run-time models directory supplies files only, never the manifest | `models/manifest.json`, `vision/engine.ts` |
| Media parsing | Images decoded with size limits (40 MP); video and camera streams handled by ffmpeg in separate processes; file camera sources confined to the import directory; camera URL schemes restricted to rtsp/rtsps/http/https/file, plus `device:` (frames pushed by a signed-in browser; nothing is fetched) | `vision/imageio.ts`, `cameras/cameraService.ts` |
| Camera credentials | Stream URLs (which carry credentials) encrypted with AES-256-GCM when `STORAGE_ENCRYPTION_KEY` is set, and masked in every API response | `cameras/cameraService.ts` |
| Interop parsing | CoT XML parsed without DTD/entity processing (declarations refused); NMEA checksums and MAVLink CRC_EXTRA verified; the MAVLink adapter never transmits | `interop/cot.ts`, `packages/adapters` |
| Least privilege | Container runs as a non-root user; failure injection is administrator-only | `Dockerfile`, `rbac.ts` |
| Documents | Text, Markdown and CSV only: NUL bytes and oversize input refused, CSV rows checked; the source, uploader and time are recorded; search returns only documents the person's clearance and organisation reach (the same rule as the register, applied in the query and in the code); the confidence label is set by someone other than the uploader | `documents/documentService.ts`, `packages/domain/src/documents/ingest.ts`, migration `014_documents.sql` |
| Clearance and organisation | Each person has a clearance and an organisation; each asset has a classification, an owner and an optional list of organisations it is shared with. One rule decides view and change (`packages/domain/src/policy/access.ts`): clearance at or above the classification, and the owning organisation or a sharing organisation for view; change needs the owner; transfer needs an administrator. A record the person cannot see is reported as unknown; relations to hidden records are withheld and counted. Every route on the asset register applies the rule | `policy/access.ts`, `routes/assets.ts`, migration `011_access.sql` |
| Release integrity | Each release has a CycloneDX SBOM and a manifest of SHA-256 digests for every shipped file, signed with Ed25519 (the private key is read from `STRATA_RELEASE_KEY_FILE` or `STRATA_RELEASE_KEY`, never stored in the repository); verification refuses a bad signature and names every changed file. Reproducibility is checked by building twice from one checkout | `scripts/release.mjs`, `scripts/lib/release.mjs`, `scripts/reproducible-check.mjs` |

## Not implemented / required before real use

- **No independent assessment.** No penetration test, source-code security audit, formal threat model,
  or certification (Common Criteria, ISO/IEC 27001, SOC 2, national accreditation) has been performed.
- **No smartcard login, and no hardware token.** The second factor is an authenticator-app code (TOTP). A smartcard or CAC reader is not available in this environment and needs hardware and an accreditation decision. SAML is not implemented; OpenID Connect is (see the Authentication row).
- **Lockout is per username.** It does not limit attempts from many usernames at one address; the login route's rate limit (20 per minute per address) does that. The password policy checks length, a denylist of common words, the account name and simple patterns. The denylist is a sample, not a breached-password corpus, and no check against breach data is made.
- **Content-Security-Policy.** Every response carries a policy: scripts, styles and fonts only from this host; no
  plugins; no framing; WebSockets and in-memory blob downloads to this host; images from this host, `data:`/`blob:` and
  the origin of the configured basemap tile template only. Inline scripts and inline styles are both refused. The
  client applies its layout through stylesheets and the CSS object model, never through style attributes in markup;
  the one place that had markup styles (the hidden SVG filter definitions) now uses a class. The application shell
  carries a fresh style nonce on each response, and the policy admits only that nonce for style elements; the two
  run-time style elements that component libraries write (the scroll lock of a modal layer, and the exit of a
  pop-out transition) take it from the page. Checked by visiting every application page and opening the overlays,
  recording refusals (none), with a control that proves an injected inline script is refused and reported.
- **Service token is a shared secret**, not per-device mutual TLS. Real sensor networks should use
  mTLS with per-device certificates and network segmentation. The field adapters speak plain UDP/TCP
  on the sensor side (as NMEA, MAVLink and CoT normally do): keep them on an isolated network segment,
  use TAK's TLS streaming through a local TLS terminator if required, and do not expose them.
- **No key rotation and no hardware-backed key storage.** Keys come from the environment or an owner-only file. Changing
  `STORAGE_ENCRYPTION_KEY` does not re-encrypt stored media, camera addresses or second-factor secrets, so a key cannot
  be rotated in place; the first encrypted object fixes the key it needs. Decide key custody before storing data. No
  hardware security module, TPM or cloud key service is used, because none is present in this environment.
- **Camera streams** are pulled over whatever the camera offers (often unencrypted RTSP). Put cameras on
  a dedicated VLAN; RTSPS where the camera supports it.
- **Biometric data protection.** Face templates and photographs are personal data of the highest
  sensitivity. Encrypt storage (`STORAGE_ENCRYPTION_KEY`) and the database volume, restrict the analyst
  role, and review the audit log. Template export/deletion workflows for individuals and a formal
  data-protection impact assessment are the operating organisation's responsibility.
- **Database encryption at rest is not done by Strata** (see above); database connections to an
  external PostgreSQL do not enforce TLS unless configured in `DATABASE_URL` (`sslmode=require`).
- **Audit chain anchoring.** Each committed audit record's sequence number and hash are appended to an anchor file
  (`AUDIT_ANCHOR_FILE`, default in `DATA_DIR`), with an HMAC when `AUDIT_ANCHOR_KEY` is set. `GET /api/audit/verify`
  reports a rewritten, missing or truncated anchored record, and a bad MAC. The anchor closes the gap only where it is
  kept out of the database administrator's reach: on a write-once volume, or on a host that only receives the lines.
  On the same disk with the same administrator it detects a rewrite but does not prevent one. Records written after
  the last anchor cannot be checked against it until the next one is written.
- **Key management.** Keys come from environment variables; there is no HSM/KMS integration or
  rotation tooling.
- **Release signing key.** The Ed25519 key is an operator file or environment variable. It is not in hardware, and
  there is no rotation or revocation list. Keep it off the build host where possible.
- **Dependency hygiene.** `npm audit` reports no vulnerabilities after the test runner was upgraded to vitest 5. Before
  that, the audit reported one moderate and two critical advisories, all in the development-only test runner and its
  `tinypool` dependency (a prototype-pollution path to remote code execution, reachable only through the test runner).
  The production dependency tree reported none at any point. The build is gated: `npm run verify` fails on any advisory
  at moderate or above, or when the audit cannot complete (`scripts/audit-gate.mjs`). A machine without network access
  cannot run the audit, so it must run where the registry mirror is reachable. The CI workflow references its actions
  by major version, not commit hash. Production deployments should still pin, mirror and scan dependencies, and build
  images reproducibly.

## Reporting

Nothing here has had an independent security assessment. Do not deploy it on an operational network,
or against real people, without the work listed above and the operating organisation's accreditation.
