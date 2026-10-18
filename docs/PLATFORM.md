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

The current controls, their tests and the gaps are in `SECURITY.md` and `CAPABILITY_MATRIX.md`. Built and tested: the
second factor for privileged roles, single sign-on with OpenID Connect, audit anchoring, signed releases, a software bill
of materials, a build gate on the dependency audit, backup and restore on both database engines, and organisation and
clearance checks on the asset register, incidents and documents. The gaps that remain: no smartcard login; no hardware-
backed key management and no key rotation (keys come from the environment or an owner-only file); single sign-on and
reproducible builds are not shown against a real provider or on a second machine; and the classification rule is applied
to three record types, not to every one. None of these is treated as solved, and none is claimed as compliant.

## Roadmap, in dependency order

1. **Assets and maintenance.** Built in this pass: register, dependency graph with loop refusal, effective availability,
   impact analysis, retirement guarded by dependents, maintenance plans with due state, append-only history.
2. **Logistics and readiness. Built.** Stock lines reference asset tags and sit on the same dependency graph. A stock-out
   impairs the dependent asset in its availability, and a reorder request needs approval by a different analyst
   (`stock.test.ts`). Not built: procurement or supplier integration.
3. **Incident and emergency coordination. Built.** Incident reports move through verification, escalation and a
   post-incident review, and the reporter cannot verify nor the resolver review their own material
   (`incident-reports.test.ts`). Reports link to affected assets. Not built: delivery to external reporting channels.
4. **Information and evidence. Built.** Documents are ingested as text, Markdown or CSV with source attribution, owner
   and classification; search results are filtered by the same access rule as the record; an analyst assigns a
   confidence label (`documents.test.ts`). Not built: text extraction from PDF or images.
5. **Interoperability. Built.** Versioned ingest, field adapters and Cursor-on-Target; JSON Schema documents generated
   from the zod schemas and checked for drift; contract tests for each adapter; an integration monitor
   (`interop-monitor.test.ts`).
6. **Administration and governance. Partly built.** Role-based access on every route, audit verification, configuration,
   organisation and classification checks on three record types, and an administrator's removal of a lost second
   factor. Missing: policy objects that administrators can edit (the rules are in code, `policy/access.ts`), and the
   same organisation and classification checks on every other record type.
7. **Security hardening. Built.** Content Security Policy without inline styles; TOTP second factor; OpenID Connect
   sign-in; persistent sign-in lockout and a password policy; audit anchoring; a software bill of materials and signed
   releases; the dependency gate in the build; backup and restore on both engines; key files with owner-only checks.
   Missing: key rotation and hardware-backed keys.
8. **Performance budgets. Built.** `npm run bench` measures bundle sizes, asset list and detail latency, and two browser
   timings against `perf/budgets.json`, and fails on an overrun. Figures, ranges and limits are in `PERFORMANCE.md`.

## Principles carried forward

- A capability is complete when it has working behaviour, validated contracts, enforced permissions, tested refusals,
  an audit trail and a browser check. An interface alone is not completion.
- Synthetic data is labelled wherever it appears. The synthetic asset register is seeded only on the demonstration site,
  and the interface names it.
- AI is not part of the asset module. Where a later module uses it, the output is advisory, cited to its sources and
  reviewed by a person; it never authorises action, identifies people for targeting, or controls equipment.
- Strata contains no weapon, effector or countermeasure control, and no roadmap item adds one. Specialised
  safety-critical and weapon-control systems are outside this repository's scope.
