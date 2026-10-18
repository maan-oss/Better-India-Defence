# Capability verification matrix

What exists in this repository, how far it has been verified, and what is missing. A module is not complete because its
interface exists. Completion needs working backend behaviour, validated contracts, enforced permissions, tested refusals,
an audit trail, a browser check and, where it matters, a measurement. Synthetic data is used for every demonstration.

## Status categories

- **Verified** — working behaviour checked by automated tests in this repository, and checked in a browser where a
  browser applies.
- **Implemented, not independently verified** — built and exercised by hand or by partial tests; no automated check
  covers the whole behaviour.
- **Partial** — some of the capability exists; named parts are missing.
- **Designed** — written down in `PLATFORM.md`; no code.
- **Infeasible / unsupported** — cannot be built as described, or is outside this repository's scope.

## Verification record for this pass

| Check | Result |
|---|---|
| Typecheck (`npm run typecheck`: domain, simulator, adapters, server, web) | Passes |
| Lint (`npm run lint`, whole repository) | Passes |
| Build (`npm run build`) | Passes |
| Unit and integration tests (`npm test`) | 19 files, 122 tests, all pass. Up from 94 at the start of the pass |
| Browser suite (`npm run test:e2e`) | 25 tests. In the full run the 23 existing tests passed; one of the two new asset tests failed on an ambiguous selector in the test itself and was fixed. Both asset tests were then rerun on their own and pass. The full suite was not rerun after that fix |
| Screenshots | Desktop and phone widths checked for the asset register: register, detail, each tab, the dependency editor |

Second round, on the same branch, covering the Content Security Policy and the dependency audit:

| Check | Result |
|---|---|
| Unit and integration tests (`npm test`) on vitest 5 | 20 files, 127 tests, all pass |
| Browser suite (`npm run test:e2e`) on the final build, policy active | 25 of 25 pass in one full run |
| Content Security Policy sweep (18 application pages, analyst session) | 0 refusals, 0 page errors |
| Positive control for the sweep (injected inline script) | Refused by the policy and reported by the check, so a clean sweep means something |
| Dependency audit (`npm audit`) | 0 vulnerabilities. Before the upgrade: 1 moderate and 2 critical, development-only |

Defects found and fixed in this pass, recorded so they are not reintroduced:

- A direct load of `/assets/:id` returned a JSON 404. The static-file rule blocked every path under `/assets/`, which is also where the build puts its chunks. The rule now targets paths with a file extension, and a test covers both sides.
- A patch that named the tag was silently ignored and returned 200. The patch schema is now strict, so it returns 400.
- The breadcrumb and address bar showed raw asset ids. Assets are now addressed by tag as well as by id, and an unknown reference returns 404.
- On a phone the list and detail panes were stacked in fixed-height boxes and the detail was clipped. On phones the register and an asset now take turns, with a way back.

## Modules named in the mandate

| Module | Status | What is there | Evidence | What is missing |
|---|---|---|---|---|
| **Operations workspace** (operational picture, alerts, incidents, readiness, teams, tasks, duty log, SITREP) | Verified for the parts tested | Alert rules, threat board, response teams with ETA, tasks, duty log (append-only), handover, SITREP, SOP checklists | `ops.test.ts`, `pipeline.test.ts`, operations browser tests | Structured incident reporting with verification states and escalation; post-incident review |
| **Geospatial workspace** (3-D world, terrain, coverage, timeline, layers) | Implemented, partially verified | Three.js world over a local tangent plane, coverage and epistemic materials, time engine, layers | Browser tests on the operational picture, run on a software renderer | Verified on real GPU hardware; streamed or large datasets; surveyed terrain (see `REALITY_LIMITS.md`) |
| **Asset and infrastructure management** | **Verified (new in this pass)** | Register with criticality and status; dependency graph with loop, self and retired-target refusal; effective availability with named causes; read-only impact analysis; guarded retirement; maintenance plans with due state; append-only history; synthetic demonstration register | Domain: `assets.test.ts` (17). Server: `assets.test.ts` (10: permissions, refusals, impact, loops, retirement, maintenance, validation, tag resolution, append-only trigger, audit chain). Browser: `assets.spec.ts` (2). Screenshots | No import from an enterprise asset system; no barcode or automatic status feed; no equipment lifecycle beyond status and warranty |
| **Incident and emergency coordination** | Partial | Incidents as space-time windows with export; teams and tasks; SOP checklists; SITREP | Operations tests | Reporting workflow with verification and escalation; linkage of incidents to assets; post-incident review |
| **Information and evidence workspace** | Implemented, partially verified | Evidence library with streamed hashing, chain of custody from the audit log, forensic enhancement records with input and output hashes, provenance labels | `vision.test.ts`, `pipeline.test.ts` | Document ingestion and search; source attribution across documents; access control applied to search results |
| **Logistics and readiness** | Partial | Readiness levels with logged changes | Operations tests | Inventory and stock; supply dependencies (designed in `PLATFORM.md`, roadmap item 2) |
| **Interoperability platform** | Verified for ingest and adapters | Versioned ingest envelopes with schema validation and dead letters; NMEA, MAVLink (receive-only) and Cursor-on-Target adapters | `pipeline.test.ts`, adapter tests, `INTEROP.md` | Schema documents generated from the zod contracts; per-adapter contract suite; an integration monitoring view beyond System Health |
| **Administration and governance** | Partial | Role-based access enforced on every route; scrypt passwords; sessions; audit with hash chain and a verify endpoint; first-run setup code; configuration | Server tests across modules; `audit/verify` in several suites | Organisational boundaries inside one deployment; classification labels on records; policy objects read by the permission checks; multi-factor authentication, single sign-on, smartcard login |

## Cross-cutting capabilities

| Capability | Status | Notes |
|---|---|---|
| Offline operation (no runtime network dependency) | Implemented, partially verified | The runtime makes no external calls unless the optional language-model copilot is configured. Not tested on an isolated network in this pass |
| Air-gapped installation | Designed | Documented in `SECURITY.md`; not installed on an isolated network |
| Audit integrity | Verified for detection | Hash chain and verify endpoint tested; append-only triggers tested. Not anchored outside the database, so a database administrator can rewrite the whole chain |
| Access control | Verified | Permission checks on every route, tested by role in asset, operations and other suites |
| Input validation | Verified | zod schemas on every request body and ingest envelope; asset-specific refusals tested |
| Vision and face recognition | Verified for the measured cases | Real CPU inference tests; measured figures in `REALITY_LIMITS.md` are bench results, not field performance |
| AI assistance | Partial | Deterministic copilot intents answer from the database. Language-model routing is optional and not tested here. No generative output is used as evidence |
| Performance budgets | Designed, not measured | No budget is set and no repeatable benchmark suite exists yet. Figures in `REALITY_LIMITS.md` come from earlier sessions and were not reproduced in this pass |
| Visual regression tests | Not implemented | Screenshots were checked by hand in this pass |
| Dependency scanning | Implemented and gated | `npm run audit` fails at moderate or above, and when the audit itself cannot complete. `npm run verify` runs types, lint, unit tests, build and the audit; `.github/workflows/ci.yml` runs it, and the browser suite after it |
| Signed releases, reproducible builds, software bill of materials | Not implemented | — |
| Backup, restore and disaster recovery | Not implemented | No tested restore procedure |
| Multi-tenancy and classification labels | Not implemented | — |
| Content Security Policy | Implemented | On every response. Inline scripts and inline styles are refused. Style elements written at run time carry the shell's per-response nonce. Checked on every application page and the overlays, with a control. See `SECURITY.md` |
| Hardware-backed key management | Not implemented | Keys come from environment variables |

## Software categories, and the decision for each

The inventory is a starting point, not a complete survey. "Not yet assessed" means no research was done in this pass.

| Category | Decision | Basis |
|---|---|---|
| Installation security operations, command and control decision support | Build (existing) | Implemented in this repository; see the module table |
| Geospatial situational awareness | Build on existing; reassess the renderer for large data | Three.js retained; 3D Tiles noted in `PLATFORM.md` as an option |
| Asset and infrastructure management | Build (done in this pass) | Verified slice; integration with enterprise systems is a later decision |
| Logistics and readiness | Build, depends on assets | Roadmap item 2 |
| Incident and emergency coordination | Build on existing | Roadmap item 3 |
| Document management and search | Not yet assessed | Needs research before design |
| Personnel administration, training, HR | Not yet assessed | Outside the current scope |
| Cybersecurity operations, network monitoring | Integrate, do not build | Interop with existing tools is the intended path |
| Secure collaboration and messaging | Not yet assessed | Outside the current scope |
| Data governance and classification | Designed | Roadmap item 6 |
| Software infrastructure (identity, audit, backup, release engineering) | Build the parts that are missing, after measuring each | Items 6 and 7 of the roadmap |
| Specialised safety-critical, classified and weapon-control systems | **Out of scope for this repository.** Requires authorised domain expertise, dedicated engineering and independent assurance. Strata contains no effector, weapon or countermeasure control, and no roadmap item adds one | — |

## What the next session should check first

1. Restart the demonstration server and confirm the asset register still seeds once and shows the synthetic label.
2. Keep the browser suite and the page sweep in the routine: the sweep is what catches Content Security Policy refusals, which the suite does not report.
3. Keep the page sweep in the routine. Refusals come from the browser's console only, so the sweep must read it.
4. Gate the build on `npm audit`.
5. Begin roadmap item 2 (logistics) only after the asset module's behaviour has been reviewed by a person.
