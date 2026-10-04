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
| Authentication | Username/password; scrypt (N=2¹⁴, r=8, p=1) with per-user 128-bit salt; constant-time comparison; 60 s lockout after 5 consecutive failures per username (in-memory) | `auth/passwords.ts` |
| Sessions | 256-bit random opaque tokens; only the SHA-256 is stored; HttpOnly, SameSite=Strict cookie (`Secure` with TLS); configurable TTL; server-side revocation on logout and user disable | `auth/authService.ts` |
| Authorisation | Four roles (viewer < operator < analyst < administrator) mapped to named permissions; every route declares its permission and is checked server-side; the client only hides what the server would refuse | `packages/domain/src/rbac.ts`, `http/guards.ts` |
| Machine access | Sensor adapters authenticate with a service token (`STRATA_SERVICE_TOKEN`) accepted only on `/api/ingest/*`, `/api/interop/cot` and media fetches; ingest only from sensor ids registered for the site | `routes/core.ts`, `routes/interop.ts` |
| Input validation | Every request body/query and every ingest envelope is validated with zod schemas; body size limits; unknown sensors and out-of-bounds timestamps are rejected to a dead-letter table | `schemas/*`, `ingest/pipeline.ts` |
| Rate limiting | Global API limit; stricter login limit (20/min/IP); ingestion exempt (authenticated by token) | `app.ts`, `routes/core.ts` |
| Audit | Append-only `audit_events` table: a database trigger rejects UPDATE/DELETE; each record holds the SHA-256 of its predecessor; `GET /api/audit/verify` recomputes the chain. Logged: sign-in/out, failed sign-in, timeline and evidence access, alert actions, incident creation/changes/exports, copilot queries, hand-off searches, reconstruction requests, scenario triggers and failure injection, user and configuration changes | `audit/audit.ts`, migration `001_core.sql` |
| Data at rest | Media / object storage encrypted with AES-256-GCM when `STORAGE_ENCRYPTION_KEY` is set. Database encryption at rest is delegated to the host (LUKS/dm-crypt or the database platform) | `storage/objectStore.ts` |
| Secrets | Only from environment variables; production mode refuses to start with the development service token; demo mode (shared demo passwords, simulator) cannot run with `NODE_ENV=production`, and demo accounts are never created outside demo mode | `config.ts` |
| First run | With no user accounts, the service issues a one-time 8-character setup code (32-symbol alphabet, about 40 bits) from the OS CSPRNG, logs it and writes it to `<DATA_DIR>/setup-code.txt` (mode 600). The setup endpoints compare it in constant time, are rate-limited (10 per minute), refuse administrator passwords under 12 characters (the wizard also requires a strength rating of at least “fair”), delete the code once the administrator exists, and audit the account creation. Restarting the API from the console requires `admin.config` and is audited | `platform.ts`, `routes/setup.ts` |
| Device cameras and positions | Browser-streamed camera frames and phone positions are accepted only from signed-in users with `ops.log`, for camera sources configured as device cameras and for existing teams; frames must be JPEG (SOI checked), size-limited and rate-limited; positions are range-checked and enter through the same ingest pipeline as any sensor | `routes/cameras.ts`, `routes/ops.ts` |
| Ground imagery | Tile templates must be http(s) XYZ; tiles are fetched by each browser, so the template reveals the site's area to the tile server. The setup wizard warns before choosing a public server (OPSEC); use your own tile server on a closed network | `packages/domain/src/facility/site.ts`, `pages/Setup.tsx` |
| HTTP hardening | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`; generic 500 messages (details only in logs) | `app.ts` |
| Logging | Structured JSON logs (pino); authorization headers, cookies and passwords redacted | `logger.ts` |
| Biometric governance | Recognition only against deliberately enrolled people; watch-list entries require a recorded basis; enrolment, watch list, review and search are analyst-only; searches require a stated purpose; every enrolment, search, review and template change is audited; unmatched sightings purged after a configurable retention period (default 30 days, hourly job); quality gates (UNUSABLE faces never matched, POOR never STRONG); AI-enhanced images never matched; thresholds are settings to be set from the site's own measurements | `identity/identityService.ts`, `routes/vision.ts` |
| Evidence integrity | Uploads streamed to storage with SHA-256 computed on the way in (de-duplicated by hash); every enhancement step records input and output hashes and parameters; evidence reports include the chain of custody from the audit log | `evidence/evidenceService.ts`, `vision/worker.ts` |
| Model integrity | Vision models pinned by SHA-256 in the manifest shipped with the code; verified at download and again before loading; a run-time models directory supplies files only, never the manifest | `models/manifest.json`, `vision/engine.ts` |
| Media parsing | Images decoded with size limits (40 MP); video and camera streams handled by ffmpeg in separate processes; file camera sources confined to the import directory; camera URL schemes restricted to rtsp/rtsps/http/https/file, plus `device:` (frames pushed by a signed-in browser; nothing is fetched) | `vision/imageio.ts`, `cameras/cameraService.ts` |
| Camera credentials | Stream URLs (which carry credentials) encrypted with AES-256-GCM when `STORAGE_ENCRYPTION_KEY` is set, and masked in every API response | `cameras/cameraService.ts` |
| Interop parsing | CoT XML parsed without DTD/entity processing (declarations refused); NMEA checksums and MAVLink CRC_EXTRA verified; the MAVLink adapter never transmits | `interop/cot.ts`, `packages/adapters` |
| Least privilege | Container runs as a non-root user; failure injection is administrator-only | `Dockerfile`, `rbac.ts` |

## Not implemented / required before real use

- **No independent assessment.** No penetration test, source-code security audit, formal threat model,
  or certification (Common Criteria, ISO/IEC 27001, SOC 2, national accreditation) has been performed.
- **No multi-factor authentication, SSO (SAML/OIDC) or smartcard login.** Passwords only.
- **Lockout is basic**: in-memory, per username, 60 s after 5 failures — it resets on restart and is not shared between instances. No password-complexity policy beyond minimum length.
- **No Content-Security-Policy header** yet (the client uses no inline scripts, so a strict CSP is
  achievable).
- **Service token is a shared secret**, not per-device mutual TLS. Real sensor networks should use
  mTLS with per-device certificates and network segmentation. The field adapters speak plain UDP/TCP
  on the sensor side (as NMEA, MAVLink and CoT normally do): keep them on an isolated network segment,
  use TAK's TLS streaming through a local TLS terminator if required, and do not expose them.
- **Camera streams** are pulled over whatever the camera offers (often unencrypted RTSP). Put cameras on
  a dedicated VLAN; RTSPS where the camera supports it.
- **Biometric data protection.** Face templates and photographs are personal data of the highest
  sensitivity. Encrypt storage (`STORAGE_ENCRYPTION_KEY`) and the database volume, restrict the analyst
  role, and review the audit log. Template export/deletion workflows for individuals and a formal
  data-protection impact assessment are the operating organisation's responsibility.
- **Database encryption at rest is not done by Strata** (see above); database connections to an
  external PostgreSQL do not enforce TLS unless configured in `DATABASE_URL` (`sslmode=require`).
- **Audit chain anchoring.** The hash chain detects modification *after* the fact by anyone who cannot
  also rewrite every later record. A database superuser can rewrite the whole chain. Anchoring the head
  hash externally (WORM storage, a separate log host, or a signing key in an HSM) is required for
  strong tamper evidence.
- **Key management.** Keys come from environment variables; there is no HSM/KMS integration or
  rotation tooling.
- **Dependency hygiene.** `npm audit` currently reports a moderate advisory in the development-only
  test runner (vitest). Production deployments should pin, mirror and scan dependencies, and build
  images reproducibly.

## Reporting

Nothing here has had an independent security assessment. Do not deploy it on an operational network,
or against real people, without the work listed above and the operating organisation's accreditation.
