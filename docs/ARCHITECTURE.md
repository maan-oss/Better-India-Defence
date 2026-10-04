# Architecture

Strata keeps a persistent, time-indexed model of one physical site, built only from sensor
observations, and lets operators move through it in space and time with the evidence for everything
they see. Read `REALITY_LIMITS.md` alongside this document.

## Components

```
                ┌───────────────────────── packages/simulator ─────────────────────────┐
                │ deterministic truth world → scenarios → sensor models → failure      │
                │ injector → HTTP transport (retry/backoff, buffering)                 │
                │ synthetic VMS (software-rendered frames on demand) + control API     │
                └───────────────┬──────────────────────────────────┬───────────────────┘
          strata.ingest/v1 over │ HTTPS + service token            │ frames (GET /vms/…)
                                ▼                                  │
┌──────────────────────────── apps/server ─────────────────────────┴──────────────────────────────┐
│ ingest pipeline: validate → registry → dedupe → time bounds → normalise (WGS84→ENU, camera     │
│   geolocation) → persist observation (one transaction) → dead letters on any rejection         │
│ fusion service: reorder buffer (watermark) → TrackEngine → track_states                         │
│ world memory: structure versions, objects, infrastructure, expected geometry                    │
│ coverage: patch visibility (cached by geometry hash) × observation history × decay             │
│ reconstruction: worker-thread pool — DSM, LiDAR change, imagery change, multi-frame, coverage  │
│ alerts · incidents · hand-off · copilot · audit · auth/RBAC · replay queries · metrics         │
│ live hub (WebSocket): track deltas, alerts, sensor status, changes, clock                       │
└───────────────┬──────────────────────────────────────────────────────────────────────────────────┘
                │ REST + WebSocket (session cookie)
                ▼
┌──────────────────────────── apps/web ────────────────────────────────────────────────────────────┐
│ React shell (top bar, rail, pages) · zustand stores (session, time, world, tracks, data)        │
│ WorldEngine (Three.js): terrain + contour/coverage shader, buildings with epistemic materials,  │
│   sensors + frustums, tracks with uncertainty, overlays, projected camera feed, DSM cells       │
│ Timeline (canvas) · inspectors · mode panels · copilot · virtualised lists                     │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

packages/domain — shared by all three: geodesy, facility definition, geometry/ray casting, zod schemas,
fusion (Kalman, association, lifecycle), coverage model, imaging (registration, super-resolution,
change detection), LiDAR, hand-off, diff, copilot intent parsing, RBAC, provenance types.
```

All three applications are TypeScript (strict, no `any`). `packages/domain` contains pure,
deterministic code with no I/O, so the same algorithms run in the server, the simulator, the browser
and the tests.

## Coordinate frames and time

- Positions arrive as WGS84 (lat, lon, height) and are converted exactly (WGS84 → ECEF → ENU) into a
  local east-north-up frame anchored at the site origin. Fusion, geometry and coverage use ENU metres.
  Both are stored.
- All times are Unix milliseconds UTC. Each observation stores `t` (when the sensor observed) and
  `received_at` (when the platform received it). Replay, fusion and diff use observation time.
- The simulator's truth is a pure function of time (seeded PRNG keyed by entity and time), so any
  moment can be regenerated and the seeded history is reproducible.

## Ingestion contract

`POST /api/ingest/batch` accepts `{ messages: Envelope[] }`; each envelope is
`{ schema: 'strata.ingest/v1', id, sensorId, kind, observedAt, payload }` with a discriminated
`kind`: `radar.track`, `rf.detection`, `camera.detections`, `drone.telemetry`, `gps.position`,
`lidar.scan` (with a binary range image uploaded through `/api/ingest/media`), `imagery.capture`,
`sensor.health`, `infrastructure.state`. Every rejection is written to `dead_letters` with its reason;
duplicates (same id) are acknowledged and ignored. A real sensor adapter is anything that can produce
these envelopes.

## Fusion

`packages/domain/src/fusion/engine.ts`. Per category (person, vehicle, aerial, unknown) a constant
velocity Kalman filter per axis, χ² gating, sensor-local-id continuity, greedy GNN association,
cooperative ids, bearing-ray and region evidence, lifecycle states and duplicate merging. The server
wraps it with a reorder buffer: observations are applied in observation-time order once the watermark
(newest observation − window) passes them; late observations are applied as out-of-sequence evidence.
Each track state is written to `track_states`, which is what replay reads. Unassociated measurements
are recorded with the reason.

## Epistemic states

Every entity exposed by the API carries `state` ∈ {CAPTURED, RECONSTRUCTED, INFERRED, PRIOR,
UNKNOWN} and `evidence: EvidenceRef[]` (observation, media, scan, capture or reconstruction ids).
The client renders the states with distinct, consistent materials and labels; it never upgrades a
state. Image products carry ORIGINAL / RESTORED / MULTI-OBSERVATION / AI-INFERRED (the last is
never produced).

## Coverage model

`packages/domain/src/coverage`. Surfaces are split into patches (walls and roofs ≈15–20 m, ground on
an 80 m grid; interiors are UNKNOWN). For each camera, patch visibility q is computed by ray casting
against the world geometry with range, incidence and resolution terms; LiDAR support comes from scan
returns; satellite captures cover roofs and ground. Confidence = 1 − Π(1 − qᵢ·e^(−ageᵢ/τ)) with
τ = 6 h, evaluated at any time. The visibility part is cached by a hash of the world geometry and
recomputed in a worker when structures change.

## World memory and diff

Structures are versioned (`spatial_assets` with `valid_from`/`valid_to` and the evidence that created
each version). Objects (`world_objects`), infrastructure states and detected changes
(`world_changes`) are time-bounded records. "The world at time t" is a query, not a snapshot copy;
periodic `world_snapshots` only accelerate it. Diff A→B compares these records and attaches coverage
at both times, so "no change detected" can be distinguished from "not observed".

## Reconstruction and analysis jobs

`apps/server/src/reconstruction`. A small worker-thread pool runs: LiDAR change detection (each ray
compared with the expected geometry; transient objects masked using tracks at scan time; obstructions
require persistence across two scans), DSM reconstruction from LiDAR (unobserved cells stay empty),
satellite change detection (normalisation, MAD threshold, opening, connected components), multi-frame
restoration (Lucas–Kanade registration + iterative back-projection), and coverage. Each job is a
`reconstructions` row with inputs, parameters, outputs, status and timings. Missing compute (e.g. GPU
photogrammetry or neural reconstruction) is not faked; such job types do not exist.

## Alerts, incidents, copilot, hand-off

- Alert rules evaluate fused tracks against zones, perimeter, sensor status, infrastructure and world
  changes; alerts are deduplicated per (rule, subject) and carry evidence.
- Incidents are space–time windows; their evidence (tracks, observations, alerts, changes, media,
  sensors not reporting) is gathered by query and can be exported as JSON.
- The copilot parses a question into a typed intent (deterministically, or via a language model when a
  key is configured) and runs a database executor that returns an answer, facts and evidence
  references. If the intent is unsupported or evidence is missing it says so.
- Hand-off searches camera detections of an enrolled synthetic subject, applies quality gates and
  space–time feasibility, and returns scored segments with blind intervals; always human-reviewed.

## Data model

PostgreSQL schema in `apps/server/src/db/migrations` (forward-only, versioned, recorded in
`schema_migrations`). Main tables:

| Table | Purpose |
|---|---|
| `facilities`, `zones`, `sensors` | Site definition and sensor registry (only registered sensors may ingest) |
| `observations` | Every accepted, normalised reading: sensor, kind, observation time, receive time, position (ENU + WGS84), payload, epistemic state, quality |
| `ingest_messages`, `dead_letters` | De-duplication ledger and rejected messages with reasons |
| `media_assets` | Frames, range scans, satellite images, reconstruction products (bytes in the object store) |
| `tracks`, `track_states` | Fused tracks and their time-indexed state history (position, velocity, covariance, lifecycle, supporting sensors) |
| `spatial_assets`, `world_objects`, `infrastructure_states`, `world_changes`, `world_snapshots` | Versioned world memory |
| `lidar_scans`, `imagery_captures`, `reconstructions` | Spatial capture metadata and analysis jobs |
| `sensor_status`, `sensor_status_events` | Current and historical sensor health |
| `alerts`, `incidents`, `test_subjects` | Operations |
| `users`, `sessions`, `audit_events`, `config` | Security and administration (audit is append-only by trigger) |
| `simulation_scenarios`, `system_state` | Simulator schedule and platform state |

Spatial queries use the ENU columns with B-tree indexes on (x, y) and time; the optional PostGIS
migration adds WGS84 geometry columns and GiST indexes for GIS interoperability. Without PostGIS (e.g.
embedded PGlite) nothing in the application changes.

Object storage is an interface (`storage/objectStore.ts`) with a local-filesystem implementation
(optionally AES-256-GCM encrypted); an S3-compatible implementation can be added behind the same
interface.

## Runtime topology

- **Development** — `npm run dev`: API (tsx), simulator (seeds history on first run, then live), Vite
  dev server with proxy. Embedded database under `data/`.
- **Production** — `npm run build && npm start`: bundled API serving the built client, bundled
  simulator. External PostgreSQL via `DATABASE_URL`, or Compose (`docker-compose.yml`).

## Performance

- Ingestion persists in batched multi-row inserts inside one transaction per batch; fusion and alerting
  run on a serialised tick, so ingest never blocks on analysis. Heavy analysis runs in worker threads.
- `/metrics` (authenticated) exposes Prometheus text-format gauges and counters: ingest rate,
  ingest latency p95, batch processing p95, event-loop lag p99, WebSocket clients, and totals for
  accepted / duplicate / rejected / late / out-of-order messages and track updates. System Health
  additionally shows fusion and HTTP latency percentiles, memory, analysis queue depth and per-service
  status.
- The client loads track history in 10-minute chunks, evaluates positions per frame without
  allocation-heavy work, uses merged/instanced geometry, a bounded label set and virtualised lists, and
  shows fps / frame time / draw calls in the Operations view.

## Testing

- `npm test` — domain unit tests (geodesy, fusion, imaging, LiDAR/coverage, hand-off/intent) and
  server integration tests (ingest → fusion → persistence → replay, robustness, RBAC, audit chain,
  copilot) on an embedded database.
- `npm run test:e2e` — builds, starts the production build with a fresh seeded database on isolated
  ports, and runs Playwright browser tests.
