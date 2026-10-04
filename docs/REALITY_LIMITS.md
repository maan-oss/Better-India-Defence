# Reality limits

This document states what Strata actually does, what it would need to do more, and what the original
product description asks for that is not possible as written. It is deliberately not softened. If a
statement elsewhere in the product or documentation contradicts this file, this file is correct.

The **demo** ("Site KESTREL", a fictional 5 × 5 km facility) runs on synthetic data from a deterministic
simulator. The platform also runs on **real inputs**: a configured real site, real camera streams
(RTSP/HTTP/recorded files), uploaded photographs and video, GPS/AVL (NMEA), UAS telemetry (MAVLink) and
track feeds from other C2 systems (Cursor-on-Target). Those paths are tested with real media and real
protocol frames (public datasets, synthetic faces of people who do not exist, frames produced by the
reference MAVLink library), but **nothing has been tested on a real military installation, real
equipment estate or in real operations.** Read the measured figures below as bench results, not field
performance.

---

## 1. WORKING NOW

These run end-to-end in this repository, are exercised by the automated tests, and were checked
manually in a browser.

### Data path

- **One ingestion API for everything.** Every sensor reading — live or recorded — enters through
  `POST /api/ingest/batch|message|media` as a versioned, schema-validated envelope
  (`strata.ingest/v1`: radar tracks, passive RF detections, camera detections, drone telemetry, GPS
  positions, LiDAR range scans, satellite image captures, sensor health, infrastructure state). The
  simulator has no back door into the database; the seeded history is produced by the same path as live
  data.
- **Robust ingestion.** De-duplication by message id; out-of-order delivery (fusion uses observation
  time, not arrival time, inside a bounded reorder window); timestamps more than 30 s in the future or
  older than 7 days are rejected to a dead-letter table with the reason; malformed payloads and
  unregistered sensors are dead-lettered; ingestion requires a service token. Covered by
  `apps/server/test/pipeline.test.ts`.
- **Failure injection** from the Simulation Lab (administrator only): sensor offline, stuck/garbled
  payloads, duplicates, bad clocks, latency, lost connection with buffered replay (network partition),
  bursts, contradictory reports. The effects are visible in System Health, the sensor list, alerts and
  the dead-letter queue.
- **Durable storage** in PostgreSQL (external, with PostGIS when available) or embedded PostgreSQL
  (PGlite) for zero-setup offline operation. Versioned forward-only migrations. Server restarts resume
  from the database: tracks, alerts, incidents and history survive.

### 4D world memory

- **Static world** (buildings, rooms, fences, roads, zones, sensors, terrain) with versioned structure
  state. Changes to structures (e.g. a collapsed roof section) are recorded as dated versions with the
  evidence that caused them, so the world at any past time can be reconstructed.
- **Time engine.** Live edge and any past time; pause, play, reverse, frame step, ×0.25 – ×10;
  timeline with observation density, alerts, incidents, detected changes and sensor outages; jump to incident / track / sensor /
  coordinates. Track positions between stored states are interpolated only when the gap is short;
  longer gaps are shown as gaps, not invented motion.
- **Sensor fusion** into unified tracks — see §1 "Fusion" below for exactly what the algorithm is.
- **Object permanence.** A track that stops being observed is not deleted. It moves to COASTING then
  LOST, its last confirmed position is kept, and its possible region grows with elapsed time (bounded
  by a speed prior for the category). Re-acquisition through the same sensor-local id within 180 s
  continues the same track.
- **Coverage / uncertainty.** The world is divided into surface patches (walls, roofs, ground grid).
  For each patch the system computes which sensors can see it (ray-cast against the world geometry,
  incidence angle, range, resolution), when it was last observed, and a confidence that decays with
  age (τ = 6 h). Interiors that no sensor can see are marked UNKNOWN, not guessed. The COVERAGE mode
  paints this onto the world.
- **Reality Ledger / Evidence Inspector.** Every displayed fact carries an epistemic state —
  CAPTURED (a sensor measured it), RECONSTRUCTED (computed from captured data by a documented
  algorithm), INFERRED (a model or rule's estimate, with its inputs), PRIOR (design data), UNKNOWN —
  and links to the observations that support it. The inspector shows those observations, their
  sensors, times and raw payloads.
- **Reality Diff** between any two times: structural versions, objects appeared/disappeared/moved,
  infrastructure state changes, LiDAR geometry changes and satellite image differences, each with
  evidence and the coverage at both times.
- **Change detection that actually computes.** LiDAR scans are compared ray-by-ray with the expected
  geometry from world memory (closer / farther returns, with transient-object masking from tracks and
  two-scan persistence before reporting an obstruction). Satellite captures are radiometrically
  normalised and differenced with a robust (MAD) threshold, morphological opening and connected
  components. The facility-damage scenario is detected by these algorithms from the synthetic sensor
  data; it is not injected as a "change" record.
- **Reconstruction jobs** run in worker threads: digital surface model from LiDAR (cells with no
  returns stay empty/unknown), imagery difference, coverage, and multi-frame restoration.
- **Multi-frame restoration.** Iterative back-projection super-resolution with Lucas–Kanade
  registration over a stack of real (synthetic-camera) frames. Output is labelled RESTORED (single
  frame, deblur/sharpen) or MULTI-OBSERVATION (several registered frames). Where a reference exists
  (synthetic ground truth), PSNR/SSIM are reported so the improvement is measured, not asserted. There
  is no generative model in the pipeline; the "AI-INFERRED" category exists in the data model and UI
  and is always empty.
- **Incident reconstruction.** Incidents gather the tracks, observations, alerts, changes, media and
  "sensors not reporting" inside a space–time window, with a replay loop and export.
- **Multi-camera hand-off demo** on enrolled **synthetic** test subjects only (a person the simulator
  generates and the operator enrols explicitly). Matching uses appearance descriptors the simulator
  emits for each detection, a space–time feasibility check between cameras (walking-speed prism through
  blind intervals) and minimum image-quality gates. Output is PROBABLE / POSSIBLE / INSUFFICIENT with
  every segment's score and always requires human review. It never asserts identity.
- **Alerts** with priority, acknowledge, assign, notes, resolve/dismiss and fly-to; rules for
  restricted zones, unidentified aerial objects, perimeter proximity, sensor outage/restoration,
  infrastructure faults, detected world changes, lost tracks of interest.
- **Copilot** that answers from the database. A deterministic intent parser and executors answer the
  supported question types (changes near a building/zone in a time window, sensors supporting a track,
  last confirmed observation, comparisons between two times, lowest-confidence regions, evidence for a
  reconstruction, sensors that stopped reporting) with evidence links. Unsupported or unanswerable
  questions get "insufficient evidence", not a guess. If an Anthropic API key is configured, a language
  model is used only to map free text onto the same intents; it never writes facts. Without a key
  everything still works.
- **Security controls**: RBAC (viewer / operator / analyst / administrator, enforced server-side on
  every route), scrypt password hashes, opaque session tokens stored as SHA-256, HttpOnly SameSite
  cookies, login rate limiting, schema validation on every input, optional TLS on the process,
  optional AES-256-GCM encryption of stored media, append-only audit log protected by a database
  trigger and a SHA-256 hash chain with a verification endpoint. See `SECURITY.md`.
- **Offline operation.** No network access is needed at runtime: no map tiles, CDNs, fonts or
  third-party services (the optional copilot language routing is the only outbound call, and it is off
  without a key).

### Vision: detection, face recognition, enhancement (real inference, CPU only)

- **Models** (pinned by SHA-256 in `models/manifest.json`, verified at download and again at load, run
  locally with ONNX Runtime on CPU — no GPU, no cloud): YOLOX-S (COCO, people/vehicles/aircraft/boats/
  birds), YuNet face detector, SFace face embedder (128-d), Real-ESRGAN ×4. All Apache-2.0 / BSD-3.
- **Object detection** on uploaded images, video (sampled frames) and live cameras, with optional tiled
  (SAHI-style) inference for small distant objects.
- **Face recognition**: enrolment of personnel and watch-list subjects from photographs (quality-graded:
  inter-ocular pixels, yaw, sharpness; UNUSABLE faces cannot be enrolled or matched), 1:N search,
  decisions STRONG / POSSIBLE / NO MATCH with the similarity shown, zone authorisation (an authorised
  person outside their cleared zones raises an alert), watch-list alerts, unknown persons in restricted
  zones, analyst review of every sighting, retention purge, purpose-stated audited searches.
- **Forensic enhancement workbench** with an edit history that hashes every step: classical restoration
  (denoise, CLAHE, dehaze, low-light, Richardson–Lucy deblur, white balance, levels, gamma, bicubic
  upscale) labelled **RESTORED**; multi-frame super-resolution from video labelled **MULTI-OBSERVATION**;
  Real-ESRGAN labelled **AI-INFERRED — not evidence**, restricted to regions ≤ 512 × 512 and never used
  as input to recognition. Evidence reports include the chain of custody from the audit log.

**Measured** (see `apps/server/src/vision/evaluate.ts`; 4-vCPU container, no GPU):

| What | Result |
|---|---|
| Face verification, LFW (550 pairs; 547 scored, 3 rejected as unusable quality) | best accuracy **98.2 %** (threshold 0.32); EER 2.7 % (0.27) |
| At the shipped STRONG threshold 0.42 | 0 false accepts in 274 impostor pairs (95 % upper bound ≈ 1.1 %); false rejects 4.4 % |
| At the POSSIBLE threshold 0.32 | 0 false accepts in 274 impostor pairs; false rejects 3.7 % |
| Synthetic CCTV composite (190 px face, blur, noise, JPEG) vs enrolment photo | similarity 0.84 (impostor −0.06) |
| YOLOX-S, one 1280×720 or 1920×1080 frame | ≈ 230 ms (tiled 1280×720: ≈ 1.6 s) |
| Face detect + embed, 1280×720 frame | ≈ 320 ms |
| Real-ESRGAN ×4, 128 → 512 px / 256 → 1024 px | ≈ 0.43 s / ≈ 2.9 s |

What these numbers do **not** say: LFW is mostly frontal, well-lit web photographs of adults; it says
nothing about night-time CCTV, IR, masks, helmets, distance, motion blur or the demographic make-up of
a particular unit. 274 impostor pairs cannot establish a false-match rate below about 1 %, and in 1:N
search the chance of a false match grows with gallery size. **Every site must measure its own error
rates on its own cameras before acting on a match**, and the thresholds are settings for that reason.
A STRONG match is a lead for a human, not an identification.

### Live cameras

- RTSP / RTSPS / HTTP(S) MJPEG / recorded files (confined to an import directory) are pulled through
  ffmpeg, analysed at a configurable rate (one frame in flight per camera; frames are dropped, never
  queued), tracked with a per-camera IoU tracker, geolocated from the surveyed camera pose and fused like
  any other sensor. Faces seen live go through the same recognition and alert rules. Operators can view
  the stream (MJPEG relay) and capture a frame into the evidence library with provenance.
- Throughput is CPU-bound: one 4-core host analyses roughly 4 frames per second in total, i.e. about
  four cameras at 1 fps, or one at 4 fps. Large camera estates need more hosts or GPU inference (not
  implemented).

### Command and control (decision support)

- Readiness states with logged changes; vital-asset definitions (inferred from restricted zones and
  their names, editable); threat evaluation of every non-cooperative track against every vital asset —
  range to boundary, time to boundary, CPA/TCPA, closing speed and a transparent score with each factor
  shown; per-rule standing operating procedures as checklists on alerts; response teams with
  dispatch, ETA and automatic "on scene"; tasks; an append-only duty log; shift handover; SITREPs
  drafted from the record (DTG, MGRS) and issued/amended with an audit trail; MGRS/UTM grid references
  throughout.
- **There is no weapon, effector or countermeasure control of any kind.** Threat scores rank tracks for
  a human; they are not hostile-intent classifications and nothing is engaged automatically.

### Real sites and interop

- A real installation is defined in **Site setup** (surveyed WGS84/MGRS anchor, orthophoto, zones,
  buildings, perimeter, gates, data feeds). The demo simulator is switched off for a configured site.
- Field adapters (`packages/adapters`, `strata-adapter`): **NMEA 0183** GGA/RMC (checksums verified,
  per-unit mapping for AVL forwarders), **MAVLink v1/v2** telemetry, **receive-only** (CRC_EXTRA
  verified; ArduPilot and PX4 modes; link quality from sequence gaps), **Cursor-on-Target** in and out
  over UDP / multicast / TCP (and an HTTP endpoint). Parsers are tested against reference sentences and
  frames generated by pymavlink. External reports keep their source's affiliation as an attributed
  assertion and are never merged into a known friendly; tracks known only from another system are not
  echoed back to it.

### Fusion — what the algorithm actually is

A per-axis constant-velocity Kalman filter (the CV model decouples exactly per axis when process noise
is isotropic), χ² (99 %) Mahalanobis gating, greedy global-nearest-neighbour association, sensor-local
id continuity, cooperative entity ids (GPS, own drones), and non-positional evidence (camera bearing
rays, RF regions) that supports or classifies a track without moving it. Track lifecycle: tentative →
confirmed → coasting → lost → closed, with duplicate-track merging. This is a reasonable engineering
baseline. It is **not** JPDA, MHT, IMM or a learned tracker, and it is listed as a limit below.

### Verified numbers (this repository, synthetic data, one developer machine)

- Seeding 120 min of recorded history through the public ingestion API: ≈107 000 messages in ≈53 s.
- Automated tests: 84 unit and integration tests in 14 files (domain, server, adapters — including
  real-model vision tests, a recorded feed played as a live camera, C2 workflows, a configured real site
  with CoT interop) and browser end-to-end tests against the production build.

---

## 2. REQUIRES REAL HARDWARE / DATA

These parts of the system are built and work against the simulator, but their real-world quality
depends entirely on equipment, data and validation that do not exist in this repository.

- **Sensors without an adapter.** Cameras (RTSP/HTTP/file), GPS/AVL (NMEA), UAS (MAVLink) and other
  C2 systems (CoT) connect today. Radar (e.g. ASTERIX CAT-048/062), passive RF, LiDAR, fence/PIDS,
  building management and satellite delivery formats still need an adapter per device family that
  converts the vendor's output into `strata.ingest/v1`; in the demo those sensors are simulated.
- **Detector suitability.** YOLOX-S is trained on COCO (daylight web images). It has not been trained
  or evaluated on thermal/IR imagery, night-time CCTV, camouflage, small drones at range or the
  site's own scenes. Expect misses and false alarms until it is fine-tuned and measured on recorded
  footage from the actual cameras.
- **Face recognition in the field.** See the measured figures and their limits in §1. Field accuracy
  depends on camera placement (faces need roughly 40+ px between the eyes for reliable matching), light,
  angle and the enrolled photographs. A lawful basis, retention policy and oversight are prerequisites,
  not features this software can supply.
- **Hand-off descriptors in the demo.** The multi-camera hand-off demo still uses the simulator's
  appearance vectors; on real cameras, cross-camera person re-identification (without faces) is not
  implemented.
- **Calibration.** Camera intrinsics/extrinsics, LiDAR poses, radar alignment and time
  synchronisation are known exactly in simulation. Real projection of tracks into video, camera
  geolocation of detections and LiDAR change detection all depend on surveyed calibration and
  disciplined clocks (PTP/GNSS); errors of a fraction of a degree become metres at range.
- **Sensor performance models.** Detection probabilities, noise levels and ranges in the simulator are
  plausible values, not measured ones. Fusion gates, alert thresholds and coverage weights must be
  re-tuned on recorded real data.
- **Geodesy and site model.** The site uses a local east-north-up frame with an arbitrary anchor and
  exact WGS84 ↔ ECEF ↔ ENU conversion. Real sites need surveyed control points, a real terrain model
  and as-built building geometry (BIM/CAD or a LiDAR survey). Interiors require floor plans.
- **Satellite imagery.** The synthetic satellite has a 15-minute revisit and 4 m GSD so that the demo
  scenarios show change detection. Real commercial imagery revisit is hours to days per sensor (better
  with large constellations and tasking, at cost), cloud cover blocks optical imaging, and delivery
  latency is typically longer than the synthetic 5 minutes.
- **Scale and throughput.** Tested with one facility, ~16 cameras, two radars and a few hundred
  concurrent tracks. Hundreds of video streams, continuous LiDAR or national-scale areas need
  partitioned ingestion, a time-series store, horizontal scaling and real load testing.
- **Video recording.** Live cameras are analysed and viewable, and frames can be captured as evidence,
  but Strata is not a recording server (NVR). Continuous recording stays with the existing VMS; recorded
  clips are brought in as evidence uploads. PTZ control and ONVIF discovery are not implemented.
- **Terrain.** Configured sites use flat ground; importing a surveyed DEM is not implemented, so
  geolocation of camera detections on sloping ground carries a corresponding error.
- **Accreditation.** The security controls are real code, but no penetration test, code audit, threat
  model review or certification (e.g. Common Criteria, ISO 27001, government accreditation) has been
  done. See `SECURITY.md`.
- **Language-model copilot routing** requires an Anthropic API key and therefore network access; the
  deterministic copilot does not.

---

## 3. NOT CURRENTLY POSSIBLE AS DESCRIBED

The product description asks for some things that cannot be built as written, by this project or by
anyone, with current physics and technology. The answer to each is **no**.

- **"Persistent 4D memory of reality."** A system only knows what its sensors observed. Everything
  between observations — inside buildings without sensors, behind walls, in shadow, at times nobody
  looked — is unknown. Strata stores *observations* and *models built from them*, and marks the rest
  UNKNOWN. It does not, and cannot, hold a complete record of reality.
- **Reconstructing unobserved events.** Replay between observations is interpolation within the
  limits of a motion model, shown with growing uncertainty. It is not a recording of what happened.
  When a track is lost the system can say where the object *could* be, not where it *is*.
- **Arbitrary image enhancement ("zoom and enhance", 10× / 100× / 1000×).** Information that a sensor
  did not capture cannot be recovered. Classical restoration makes captured detail easier to see;
  multi-frame super-resolution can recover modest additional detail (in practice up to about 2×
  linear) from several sub-pixel-shifted frames of a static target. Beyond that, detail is invented.
  Strata does ship a generative enhancer (Real-ESRGAN) because a sharper picture helps an operator
  orient — but its output is labelled AI-INFERRED, is excluded from recognition, and must never be
  presented as evidence of what was there (a number plate, a face, a weapon).
- **Identifying people from low-resolution or distant imagery.** Below a certain pixel density there
  is no identity information in the image. The face pipeline grades every face and refuses to match
  UNUSABLE ones; POOR-quality faces can never produce a STRONG match; and an AI-enhanced face is never
  matched. No model can identify a face that occupies a handful of pixels.
- **Certainty from fusion.** Fusing sensors reduces uncertainty; it does not remove it. Every track,
  classification and match carries a confidence and the evidence behind it; none is presented as
  ground truth.
- **Seeing through walls / inside unobserved interiors** with the sensors described (cameras, radar
  for airspace, LiDAR, satellite). Not possible. Interiors are UNKNOWN unless an interior sensor
  observes them.
- **Instantaneous global awareness.** Satellite imagery is periodic and delayed; radar and RF have
  line-of-sight and range limits; cameras have fields of view. Coverage gaps are inherent and Strata
  shows them rather than hiding them.

---

## 4. Implementation choices that differ from the description

- **Three.js instead of CesiumJS.** The site is a 5 × 5 km local area in a local tangent-plane frame,
  with no real terrain or imagery tiles to stream, and the product must run fully offline. CesiumJS's
  advantages (global ellipsoid, 3D Tiles streaming, Ion imagery) do not apply without real data and an
  Ion/tile server; Three.js gave full control over custom shading (coverage, epistemic states,
  projected camera feeds) with a much smaller bundle. Positions are stored as WGS84 and local ENU, so a
  move to CesiumJS / 3D Tiles for real geospatial data is a rendering change, not a data-model change.
- **Projected camera feeds ignore occlusion.** The live video texture is projected onto terrain and
  façades without a depth test against intervening geometry; detection geolocation *does* ray-cast
  against world geometry.
- **Fixed daylight.** The synthetic renderer uses constant illumination; there is no night, weather
  or thermal imaging model.
- **No browser web workers and no distance-based level of detail.** Heavy computation (coverage,
  reconstruction, change detection, super-resolution) runs server-side in worker threads. The client
  uses merged static geometry, instancing for reconstruction cells, frustum culling, a priority- and
  overlap-limited label set, chunked track storage, virtualised lists and on-screen frame
  instrumentation (fps, frame time, draw calls, triangles). That is sufficient for one 5 × 5 km site;
  it is not a streaming LOD system for city- or country-scale geometry.
- **Covariance simplifications.** Measurement noise is diagonal per axis; the CV filter has no
  manoeuvre model (no IMM). Closely crossing targets can swap or fragment, and the seeded data shows
  some aerial track fragmentation (more than one alert for one drone).
- **Docker image not built here.** The Dockerfile and Compose file are provided (the image includes
  ffmpeg, the vision models and the adapters), but the development environment had no Docker daemon, so
  the image has not been built or run. `npm run build && npm start`, the bundled vision worker and the
  bundled adapter (the same artefacts the image runs) were verified.
- **Dependency advisory.** `npm audit` reports a moderate advisory in the test runner (vitest
  `@vitest/mocker`), a development-only dependency not shipped in the build. Fixing it requires a
  major-version upgrade that has not been done.
