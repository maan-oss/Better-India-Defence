# Strata — 4D Reality Intelligence Platform

Strata builds a persistent, time-indexed spatial memory of a physical site from sensor observations
and lets operators move through it in three dimensions and in time — live, or any moment in the
recorded past — with the evidence behind everything on screen.

It ships with **Site KESTREL**, a fictional 5 × 5 km test facility, and a deterministic simulator that
drives synthetic cameras, radar, passive RF, LiDAR, drones, GPS, fence sensors, building systems and a
satellite through the same ingestion API a real sensor would use. **All data is synthetic.**

> Before relying on anything here, read **[docs/REALITY_LIMITS.md](docs/REALITY_LIMITS.md)** — what
> works now, what needs real hardware and data, and what the original brief asks for that is not
> possible.

## Quick start

Requirements: Node.js ≥ 22.12, npm. No database, Docker or network access needed.

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173> and sign in as `analyst` / `strata-demo`.

On first run `npm run dev` starts the API with an embedded PostgreSQL (under `data/`), records two
hours of synthetic history through the ingestion API (about a minute), then starts the live simulator
and the web client. Later runs resume from the stored data. To start over, stop the stack and delete
`data/`.

Demo accounts (development only), all with password `strata-demo`:

| User | Role | Can |
|---|---|---|
| `viewer` | Viewer | See the world, timeline, alerts and evidence |
| `operator` | Operator | + acknowledge/assign alerts, create/edit incidents, trigger scenarios, system health |
| `analyst` | Analyst | + reconstructions, exports, identity hand-off demo, audit log |
| `admin` | Administrator | + users, configuration, failure injection |

## What to try

1. **Operations** — the 4D world. Orbit (drag), pan (right-drag), zoom (wheel); switch to Fly or
   Walk (first person, eye height 1.7 m) in the left panel and move with `W A S D Q E` (`Shift` faster).
   Click a building, track or sensor for the inspector. Search (top bar) jumps to tracks, sensors,
   buildings, incidents or coordinates.
2. **Timeline** (bottom) — click or drag to go back in time; play, reverse, step, ×0.25–×10; `LIVE`
   (or `L`) returns to the live edge; `Space` plays/pauses, `←`/`→` step. The timeline shows observation density by sensor type, alerts, incidents, detected changes and sensor outages.
3. **Modes** (top bar) — NOW, HISTORY, INCIDENT (replay an incident window in a loop), DIFF (compare
   two times; drag the A and B handles), EVIDENCE (what is captured vs reconstructed vs inferred),
   COVERAGE (how well and how recently each surface was observed).
4. **Evidence Inspector** — select Hangar 1 and open a surface: which sensors observed it, when, with
   what confidence, and the raw observations.
5. **Ask the record** (`/`) — e.g. "What changed around Building G during the last hour?" or "Which
   sensors stopped reporting before this incident?". Answers cite evidence or say there is not enough.
6. **Incidents** — the recorded drone incursion and perimeter breach, with gathered evidence, the
   sensors that were not reporting, replay and export.
7. **Sensors** — live synthetic camera feeds with detections, radar/RF/LiDAR status and history.
8. **Reconstructions** — LiDAR surface model, satellite change detection (the facility-damage
   scenario), multi-frame restoration with measured PSNR/SSIM.
9. **Evidence** — observation search, media, and the multi-camera hand-off demo on the enrolled
   synthetic subject (analyst; always marked "human review required").
10. **Simulation Lab** — trigger scenarios (unidentified drone, perimeter breach, sensor failure,
    network partition, multiple objects, false positive, facility damage…) and inject failures
    (administrator).
11. **System Health** and **Audit** — pipeline metrics, dead letters, hash-chain verification.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Development stack: API + seed on first run + live simulator + Vite |
| `npm run seed` | Seed recorded history into an empty database (`SEED_MINUTES`, default 120) |
| `npm run db:migrate` | Apply database migrations |
| `npm run typecheck` | Strict TypeScript across all four projects |
| `npm run lint` | ESLint (no `any`, consistent type imports, React hooks rules) |
| `npm test` | Unit + integration tests (embedded database) |
| `npm run test:e2e` | Production build + Playwright browser tests on isolated ports |
| `npm run build` | Typecheck, bundle server and simulator, build web client |
| `npm start` | Run the production build (see below) |
| `scripts/stop-dev.sh` | Stop processes started by `npm run dev` / `npm start` |

## Production

```bash
cp .env.example .env     # set STRATA_SERVICE_TOKEN, STRATA_ADMIN_PASSWORD, STRATA_DEMO_USERS=false …
npm run build
npm start                # API + web client on PORT (default 4000); simulator unless STRATA_SIMULATOR=false
```

Production mode refuses to start with development secrets or demo users. Set `DATABASE_URL` to use an
external PostgreSQL 16 (PostGIS optional), `TLS_CERT_FILE`/`TLS_KEY_FILE` for TLS (or
`COOKIE_SECURE=true` behind a TLS proxy), and `STORAGE_ENCRYPTION_KEY` to encrypt stored media.

`docker-compose.yml` runs PostgreSQL + PostGIS and the application image (`Dockerfile`). Note: the
image was not built in the development environment (no Docker daemon was available); the commands it
runs (`npm run build`, `npm start`) were verified.

## Connecting a real sensor

Anything that can POST `strata.ingest/v1` envelopes to `/api/ingest/batch` with the service token
(`Authorization: Bearer $STRATA_SERVICE_TOKEN`) and is registered in the facility's sensor list is a
sensor. See `packages/domain/src/schemas/ingest.ts` for the message kinds and
`packages/simulator/src/sensors/models.ts` for how the synthetic sensors build them.

## Repository layout

```
packages/domain      shared, pure TypeScript: geodesy, facility, geometry, schemas, fusion, coverage,
                     imaging, LiDAR, hand-off, diff, copilot intents, RBAC, provenance
packages/simulator   deterministic truth world, scenarios, sensor models, renderer, failure injection
apps/server          Fastify API: ingestion, fusion, world memory, reconstruction, alerts, incidents,
                     copilot, hand-off, auth, audit, replay, WebSocket
apps/web             React + Three.js client
e2e                  Playwright tests
docs                 ARCHITECTURE, SECURITY, REALITY_LIMITS
```

## Documentation

- [docs/REALITY_LIMITS.md](docs/REALITY_LIMITS.md) — what is real, what is not, and what cannot be
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, algorithms, data model, runtime
- [docs/SECURITY.md](docs/SECURITY.md) — implemented controls and what is missing for real use

## Responsible use

Strata is a demonstration built on synthetic data. It contains no facial recognition, no weapon or
effector control and no targeting functions, and it is not designed for surveillance of the public.
Identity hand-off works only on explicitly enrolled synthetic test subjects and always requires human
review.
