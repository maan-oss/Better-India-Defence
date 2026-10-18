# Platform direction

This records the architecture decision for Strata as a platform, what the public research established and what it did
not, and the order of the work that follows. It is written so that a later session can pick up from it without
re-deriving the reasoning. `CAPABILITY_MATRIX.md` says what is built and how far it has been verified.

## Decision: a modular monolith with module contracts

**Context, from the repository.** One repository, one deployable server, one web client and one PostgreSQL schema
(PGlite when embedded). Ingestion, fusion, world memory, vision, command and control, interop and administration already
run in one process and share transactions and the audit log. Sites must keep working when the network is down.

**Options.**

- *Microservices.* Rejected for now. The drivers that would justify them are not present: no module needs independent
  scaling, every deployment is one site, and a service boundary adds a network failure between operations that must
  commit together (a status change and its audit record, a dependency change and its loop check). Revisit when a module
  needs separate scaling, a separate classification domain or a separate release cadence.
- *Modular monolith with explicit module contracts (chosen).* Each capability is a vertical slice with the same parts,
  so its boundary is visible in the tree and enforced by review and tests rather than by a network.
- *Federation of separate deployments.* Deferred. The seam for exchanging data with other systems is the interop layer
  (versioned ingest envelopes, Cursor-on-Target, field adapters), not a shared database.

**What a module provides.** The asset register is the reference example:

1. Pure rules in `packages/domain/src/<module>/` (dependency closure, loop detection, effective availability, impact,
   due state). These run in the server, the browser and the tests.
2. Request schemas in `packages/domain/src/schemas/<module>.ts`, validated before the service sees input.
3. Response shapes in `packages/domain/src/<module>/views.ts`, so server and client share one definition.
4. A service in `apps/server/src/<module>/` with no HTTP code. Every write runs in one transaction with its history
   record.
5. Routes in `apps/server/src/routes/<module>.ts`. Every route declares a permission. Every mutation writes an audit
   record. Service refusals map to explicit HTTP status codes.
6. A forward-only migration, numbered. Records that must not change after the fact are protected by a trigger, as
   `audit_events` and `asset_events` are.
7. A web page, a navigation entry and a permission gate. The browser shows a control only when the signed-in role has
   the permission the server checks.
8. Tests at each layer: domain unit tests, server integration tests covering permissions, validation and refusals, and
   at least one browser test.

**Cross-module coupling is limited to** the shared domain functions, the audit log and the permission map. A module
does not read another module's tables directly; the asset register does not depend on the operations tables, and
readiness and teams do not depend on the asset register. Where two modules must agree, they agree through an API.

## Research basis

Sources were checked with web search. Only the search results and official index pages were read; full documents were
not opened, so the claims below are at the level the sources support.

| Source | What was checked | What Strata takes from it | What is not claimed |
|---|---|---|---|
| Palantir Foundry, object types | Official object-type documentation index | Object types with typed properties, primary keys, backing datasets, link types and action types as the modelling vocabulary | Any equivalence with Foundry, Gotham or AIP. Modelling the dependency graph as a link type and making retirement a guarded action is our inference from that vocabulary |
| NASA Open MCT | Official documentation and a NASA/AIAA paper on the earlier bundle-based design | Detachable plugins composed into one application; a heavy view can be isolated and measured separately | Whether the current release removed the bundle API. A third-party source says it did; the official migration notes were not read, so this is unverified |
| Anduril Lattice | SDK overview on the official documentation site | Integration is through entities and tasks interfaces (gRPC or HTTP) | Any integration or compatibility. Third-party sources say live access is partner-gated and export-controlled, so Strata does not connect to Lattice |
| NATO Federated Mission Networking | ACT overview and encyclopaedia summary | Interoperability is specified by governance, a framework and standards, not by one product | Any implementation. FMN is not software that Strata can implement |
| OGC 3D Tiles | OGC community standard listing (versions 1.0 and 1.1) | A candidate streaming format if the geospatial workspace moves to large, tiled 3D datasets | Current use. The renderer is three.js over a local tangent plane (see `REALITY_LIMITS.md`). The 1.1 text was not read in full |

**Not researched in this pass**, and therefore no claim is made about them: Esri ArcGIS Mission and related geospatial
platforms; Indian indigenous defence software programmes and their published requirements; safety-critical human-machine
interface standards; sovereign-cloud reference architectures. Each is an open research item before any module that
depends on it is designed.

## Security and sovereignty requirements

The current controls, their tests and the gaps are in `SECURITY.md` and `CAPABILITY_MATRIX.md`. The gaps that bear on
the platform direction are: no smartcard login; no hardware-backed key management or key rotation (keys come from the
environment or an owner-only file); audit records are hash-chained but not anchored outside the database; releases are not signed and builds are
not reproducible; no software bill of materials is produced; the audit is clean but nothing gates a build on it; there is no backup and restore procedure with a tested recovery; and there is no tenancy or organisational
boundary inside one deployment. None of these is treated as solved, and none is claimed as compliant.

## Roadmap, in dependency order

1. **Assets and maintenance.** Built in this pass: register, dependency graph with loop refusal, effective availability,
   impact analysis, retirement guarded by dependents, maintenance plans with due state, append-only history.
2. **Logistics and readiness.** Depends on (1): stock lines reference asset tags, supply dependencies are edges in the
   same graph, and reorder thresholds raise a recommendation that a person approves. Acceptance: the impact analysis
   reports a stock-out that would impair a dependent asset.
3. **Incident and emergency coordination.** Partly built (incidents as space-time windows, teams, tasks, checklists,
   duty log). Missing: structured reporting with verification states, escalation rules and a post-incident review.
   Depends on (1) to link affected assets.
4. **Information and evidence.** Partly built (evidence library, provenance, chain of custody). Missing: ingestion and
   search over documents with source attribution, access control applied to search results, and confidence labels.
5. **Interoperability.** Partly built (versioned ingest, field adapters, Cursor-on-Target). Missing: schema documents
   generated from the zod schemas, contract tests for each adapter, and an integration monitoring view.
6. **Administration and governance.** Partly built (role-based access, audit verification, configuration). Missing:
   organisational boundaries inside one deployment, data classification on records, and policy objects that the
   permission checks read.
7. **Security hardening.** Removing the inline-style allowance from the Content Security Policy, multi-factor authentication design, audit anchoring, a software
   bill of materials and a dependency gate in the build, and a restore test.
8. **Performance budgets.** Set and measure before optimising. No budget is claimed until a repeatable benchmark exists.

## Principles carried forward

- A capability is complete when it has working behaviour, validated contracts, enforced permissions, tested refusals,
  an audit trail and a browser check. An interface alone is not completion.
- Synthetic data is labelled wherever it appears. The synthetic asset register is seeded only on the demonstration site,
  and the interface names it.
- AI is not part of the asset module. Where a later module uses it, the output is advisory, cited to its sources and
  reviewed by a person; it never authorises action, identifies people for targeting, or controls equipment.
- Strata contains no weapon, effector or countermeasure control, and no roadmap item adds one. Specialised
  safety-critical and weapon-control systems are outside this repository's scope.
