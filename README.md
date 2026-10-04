# Strata — 4D Reality Intelligence Platform

Strata is a base-security and situational-awareness system for a defended installation. It fuses
cameras, GPS/AVL, UAS telemetry, other C2 systems' tracks and site sensors into one picture that
operators can move through in three dimensions and in time, with the evidence behind everything on
screen, and supports the control room's work: threat evaluation against vital assets, alerts with
standing-operating-procedure checklists, QRT dispatch, duty log, handover and SITREPs.

What runs on real inputs today:

- **Live cameras** (RTSP/HTTP/recorded files) analysed on site on CPU: people, vehicles, aircraft,
  boats; **face recognition** of enrolled personnel (zone authorisation) and watch-list subjects, with
  measured error rates and human review; a camera wall for the whole estate.
- **Tactical display**: APP-6 / MIL-STD-2525-style symbology, MGRS grid, compass, scale bar, cursor
  grid reference; a plan-view tactical scope; a night (red-light) display mode.
- **Field view** for responders on phones and tablets: task, bearing and distance, local picture,
  SALUTE contact reports and an assistance request.
- **Media forensics**: upload photos and video; detection, face grouping, classical restoration,
  multi-frame super-resolution and a clearly labelled AI enhancer, with hashed edit history and chain of
  custody.
- **Command and control** decision support (no weapon or effector control).
- **Real sites** defined from a surveyed anchor and an orthophoto; MGRS throughout.
- **Interop**: NMEA 0183, MAVLink (receive-only) and Cursor-on-Target in/out (ATAK/TAK).

It also ships with **Site KESTREL**, a fictional 5 × 5 km demo facility, and a deterministic simulator
that drives synthetic cameras, radar, passive RF, LiDAR, drones, GPS, fence sensors, building systems,
a satellite and a neighbouring unit's CoT feed through the same ingestion API real equipment uses.

> Before relying on anything here, read **[docs/REALITY_LIMITS.md](docs/REALITY_LIMITS.md)** — what
> works now (with measured accuracy and speed), what needs real hardware, data and validation, and what
> is not possible. Nothing here has been tested on a real installation.

## Quick start

Requirements: Node.js ≥ 22.12, npm; ffmpeg for video and network cameras (images work without it).
No database, Docker, GPU or network access needed at run time.

```bash
npm install
npm run models:fetch     # once: downloads the vision models (≈ 76 MB) and verifies their SHA-256
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
| `operator` | Operator | + acknowledge/assign alerts, dispatch teams, duty log, incidents, upload/enhance evidence, see recognition results |
| `analyst` | Analyst | + enrol personnel / watch list, review sightings, face search (purpose required), readiness, exports, audit |
| `admin` | Administrator | + users, cameras, site definition, configuration, failure injection |

How an installation uses each screen day to day: **[docs/OPERATIONS.md](docs/OPERATIONS.md)**.

## What to try

1. **Command** — KPI strip, readiness, the threat board (every non-cooperative track ranked against the
   vital assets with each factor shown), the tactical scope (plan view with tactical symbols and threat
   vectors), alerts with SOP checklists, dispatch a QRT and watch its ETA, duty log, handover, draft and
   issue a SITREP. Grid references are MGRS (search accepts them too).
2. **Camera wall** — every site camera plus analysed live streams in 1/4/9/16 layouts, guard tour, alert
   flashing. The demo includes an *Operations Centre door* face-capture camera playing a generated
   recording of two synthetic faces: watch it recognise the authorised sergeant and flag the watch-list
   subject.
3. **Identity** — review the demo sightings (pending verification), enrol a person from a photograph
   (the quality grade shows whether it is usable), set cleared zones; add a watch-list subject (a basis is
   required).
4. **Media forensics** — two analysed sample images are preloaded; upload your own photo or video:
   detections, faces, enhancement (compare before/after, every step hashed), multi-frame
   super-resolution from video, evidence report with chain of custody.
5. **Field view** (also on a phone: the navigation moves to the bottom) — pick a team, follow its task
   (grid, distance, bearing, ETA, status), local picture, nearby alerts, SALUTE contact report, and
   press-and-hold assistance request. Dispatch a team from Command first to see a task arrive.
6. **Night display** — user menu → *Night display (red light)* for darkened operations rooms.
7. **Site setup** — define a real installation (anchor, orthophoto, zones, buildings, perimeter, gates,
   data feeds); start from the demo layout to see the editor.
8. **Operational picture** — the 4D world with tactical symbols and the MGRS grid. Orbit (drag), pan (right-drag), zoom (wheel); switch to Fly or
   Walk (first person, eye height 1.7 m) in the left panel and move with `W A S D Q E` (`Shift` faster).
   Click a building, track or sensor for the inspector. Search (top bar) jumps to tracks, sensors,
   buildings, incidents or coordinates.
9. **Timeline** (bottom) — click or drag to go back in time; play, reverse, step, ×0.25–×10; `LIVE`
   (or `L`) returns to the live edge; `Space` plays/pauses, `←`/`→` step. The timeline shows observation density by sensor type, alerts, incidents, detected changes and sensor outages.
10. **Modes** (top bar) — NOW, HISTORY, INCIDENT (replay an incident window in a loop), DIFF (compare
   two times; drag the A and B handles), EVIDENCE (what is captured vs reconstructed vs inferred),
   COVERAGE (how well and how recently each surface was observed).
11. **Evidence Inspector** — select Hangar 1 and open a surface: which sensors observed it, when, with
   what confidence, and the raw observations.
12. **Ask the record** (`/`) — e.g. "What changed around Building G during the last hour?" or "Which
   sensors stopped reporting before this incident?". Answers cite evidence or say there is not enough.
13. **Incidents** — the recorded drone incursion and perimeter breach, with gathered evidence, the
   sensors that were not reporting, replay and export.
14. **Sensors** — map of the sensor estate by status; per-sensor diagnostics, feeds and history.
15. **Reconstructions** — LiDAR surface model, satellite change detection (the facility-damage
   scenario), multi-frame restoration with measured PSNR/SSIM.
16. **Evidence** — observation search, media, and the multi-camera hand-off demo on the enrolled
   synthetic subject (analyst; always marked "human review required").
17. **Simulation Lab** — trigger scenarios (unidentified drone, perimeter breach, sensor failure,
    network partition, multiple objects, false positive, facility damage…) and inject failures
    (administrator).
18. **System Health** and **Audit** — pipeline metrics, dead letters, hash-chain verification.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Development stack: API + seed on first run + live simulator + Vite |
| `npm run seed` | Seed recorded history into an empty database (`SEED_MINUTES`, default 120) |
| `npm run db:migrate` | Apply database migrations |
| `npm run models:fetch` | Download and verify the vision models (`STRATA_MODELS_DIR` to choose where) |
| `npm run vision:eval -w @strata/server -- --pairs <dir>` | Measure face-verification accuracy on your own labelled pairs |
| `npm run typecheck` | Strict TypeScript across all projects |
| `npm run lint` | ESLint (no `any`, consistent type imports, React hooks rules) |
| `npm test` | Unit + integration tests (embedded database) |
| `npm run test:e2e` | Production build + Playwright browser tests on isolated ports |
| `npm run build` | Typecheck, bundle server, vision worker, simulator and adapters, build web client |
| `node packages/adapters/dist/cli.js adapters.json` | Field adapters: NMEA, MAVLink, CoT ([docs/INTEROP.md](docs/INTEROP.md)) |
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

For a real installation: define the site in **Site setup** (a configured site turns the simulator
off), add cameras in **Live Cameras**, run the field adapters, and use a fresh database. Air-gapped
hosts: run `npm run models:fetch` on a connected machine, copy the `models/` files across and set
`STRATA_MODELS_DIR` (hashes are checked against the manifest that ships with the code).

`docker-compose.yml` runs PostgreSQL + PostGIS and the application image (`Dockerfile`, which includes
ffmpeg, the models and the adapters; `--profile adapters` adds the adapter service). Note: the image
was not built in the development environment (no Docker daemon was available); the artefacts it runs
(`npm run build`, `npm start`, the bundled vision worker and adapter) were verified.

## Connecting equipment

Cameras connect directly (RTSP/HTTP). GPS/AVL (NMEA), UAS ground stations (MAVLink) and TAK/C2 systems
(Cursor-on-Target) connect through `strata-adapter`. Anything else that can POST `strata.ingest/v1`
envelopes to `/api/ingest/batch` with the service token and is registered for the site is a sensor.
See **[docs/INTEROP.md](docs/INTEROP.md)**.

## Repository layout

```
packages/domain      shared, pure TypeScript: geodesy, facility, geometry, schemas, fusion, coverage,
                     imaging, LiDAR, hand-off, diff, copilot intents, RBAC, provenance
                     vision pre/post-processing and restoration, MGRS, threat evaluation, SOPs, CoT
packages/simulator   deterministic truth world, scenarios, sensor models, renderer, failure injection
packages/adapters    strata-adapter: NMEA 0183, MAVLink, Cursor-on-Target field adapters
apps/server          Fastify API: ingestion, fusion, world memory, reconstruction, alerts, incidents,
                     vision engine (ONNX Runtime, CPU), evidence, identity, live cameras, C2 (ops),
                     site configuration, interop, copilot, auth, audit, replay, WebSocket
models               model manifest (pinned SHA-256); model files are fetched, not committed
apps/web             React + Three.js client
e2e                  Playwright tests
docs                 OPERATIONS, INTEROP, ARCHITECTURE, SECURITY, REALITY_LIMITS
```

## Documentation

- [docs/REALITY_LIMITS.md](docs/REALITY_LIMITS.md) — what is real, what is not, and what cannot be
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — operator's guide: roles, set-up, daily routines
- [docs/INTEROP.md](docs/INTEROP.md) — cameras, NMEA, MAVLink, Cursor-on-Target, writing adapters
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, algorithms, data model, runtime
- [docs/SECURITY.md](docs/SECURITY.md) — implemented controls and what is missing for real use

## Responsible use

Strata is decision support for the security of a defended installation. It contains **no weapon,
effector or countermeasure control and no targeting functions**, and nothing in it acts on its own:
threat scores rank tracks for a person, and alerts ask a person to verify.

Face recognition matches only against people deliberately enrolled (personnel, and watch-list
subjects with a recorded basis). Every match shows its similarity and quality, POOR-quality faces can
never produce a strong match, AI-enhanced images are never matched, every sighting can be reviewed,
searches require a stated purpose, unmatched sightings are purged after a retention period, and all of
it is audited. A match is a lead for a human, not an identification. Using biometric identification
requires a lawful basis and oversight that the operating organisation must establish; it is not
designed or suitable for surveillance of the public. Repository test faces are synthetic (people who
do not exist).
