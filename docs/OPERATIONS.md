# Operating Strata at an installation

This is the operator's guide: who uses which screen, and how the system supports base security
routines. It describes decision support for people. Strata controls no weapon, effector or
countermeasure, and nothing in it acts on its own.

Read [REALITY_LIMITS.md](REALITY_LIMITS.md) first, especially the measured face-recognition error
rates and what they do not cover.

## Roles

| Role | Typical user | Can |
|---|---|---|
| Viewer | Duty officer's screen, briefing room | See the picture, timeline, alerts, evidence |
| Operator | Control-room operator, guard commander | + acknowledge/assign alerts, dispatch QRT/patrols, duty log, incidents, upload and enhance evidence, see recognition results |
| Analyst | Security/intelligence cell | + enrol personnel and watch-list subjects, review sightings, purpose-stated face search, readiness state, evidence export, audit |
| Administrator | Signals / IT detachment | + users, cameras, site definition, configuration |

Every action that matters (log-ins, enrolment, searches with their stated purpose, dispatches, SITREPs,
readiness changes, evidence exports) goes to an append-only, hash-chained audit log.

## Setting up an installation (administrator, once)

1. **Site setup** — set the surveyed anchor (lat/lon or MGRS), load an orthophoto (survey cell, drone
   mosaic or licensed imagery) and trace the perimeter, gates, buildings and zones on it. Mark the zones
   that must be protected as *restricted*; their names drive the default vital-asset type and priority
   ("Armoury", "Fuel point", "Ops room", "Substation"…). Add the **data feeds** the adapters will post as
   (`GPS1` for AVL/NMEA, `UAV1` for a MAVLink ground station, `EXT1` for a CoT/TAK feed). Save and
   restart; the demo simulator does not run on a configured site. Use a fresh database for a real site.
2. **Live cameras** — add each camera (RTSP/HTTP URL; credentials are stored encrypted), its surveyed
   position, mounting height, heading, tilt and field of view, the zone it watches and the analysis rate.
   *Test* shows a frame before saving. Detections are geolocated from this pose, so survey it.
3. **Command → Vital assets** — check the derived assets, priorities (1 = highest) and protection radii.
4. **Field adapters** — run `strata-adapter` with a config listing the NMEA, MAVLink and CoT listeners
   ([INTEROP.md](INTEROP.md)).
5. **Users** — create accounts with the least role each person needs; disable demo users (production
   mode refuses to start with them).

## Daily routines

### Control room (operator)

- **Command** is the watch screen: readiness state, the threat board (every non-cooperative track
  ranked against every vital asset: range to boundary, time to boundary, closest approach, closing
  speed, and the score's factors), open alerts, team status and the duty log.
- **Alerts** arrive with a sound (top bar: ALARM ON/OFF) and a standing-operating-procedure checklist
  for the rule that fired (e.g. *Perimeter proximity*: verify on camera → dispatch nearest patrol →
  illuminate the area → log identity / vehicle registration). Ticking an item records who and when.
- **Dispatch** a team from an alert or a track: Strata computes the ETA from the team's last position
  and marks the task *on scene* when the team's tracker comes within 35 m. For teams without trackers the
  operator sets the task status (en route, on scene, complete) by hand; each change is logged.
- **Duty log** entries are append-only; corrections are new entries.
- **Handover** at shift change produces a summary (open alerts and tasks, teams, readiness, notable
  events) that the incoming operator acknowledges.
- **SITREP**: *Draft* fills a report from the record (DTG, MGRS grid references, alerts, incidents,
  teams, the top threats); edit, then *Issue*. Amendments are kept as versions.

### Gate and perimeter (operator / guard commander)

- **Live Cameras** shows each analysed stream with detections and recognised faces. A personnel member
  seen in a zone they are not cleared for raises *Unauthorised zone access*; an unknown face in a
  restricted zone raises *Unknown person in restricted zone* (configurable); a watch-list match raises
  *Watch-list candidate* (critical when the subject is marked high-threat and the match is STRONG).
- **Capture** saves the current frame to the evidence library with camera, time and provenance.

### Security cell (analyst)

- **Identity** — enrol personnel (name, service number, unit, cleared zones) and watch-list subjects
  (with the *basis* for listing, which is mandatory) from good photographs; the quality grade tells you
  whether a photo is usable. Review sightings: confirm, reject or mark *needs follow-up*; your decision is
  recorded. *Face search* requires a stated purpose, which is audited. Unmatched sightings are purged
  after the retention period (default 30 days).
- **Media Forensics** — upload photographs or video (from a patrol phone, a VMS export, a drone). Strata
  detects people, vehicles and faces, groups faces by appearance, and lets you enhance a region:
  *RESTORED* operations (denoise, contrast, dehaze, low-light, deblur…) make captured detail easier to
  see; *MULTI-OBSERVATION* combines several video frames; *AI-INFERRED* (Real-ESRGAN) is for orientation
  only and is never evidence. The evidence report lists every step with hashes and the chain of custody.
- **Readiness** — set the readiness state (with a reason, logged and broadcast to every console).

### After an incident

- **Incidents** gathers tracks, observations, alerts, camera frames and "sensors not reporting" for the
  time window; replay it in the 4-D view; export the evidence package (analyst).
- **Ask the record** (`/`) answers questions from the database with evidence links, or says there is
  not enough evidence.

## Working with other systems

- Tracks from a brigade TAK server, a neighbouring unit or an air-defence picture arrive over CoT as an
  *external feed*. Their affiliation (friend / hostile / suspect / neutral / unknown) is that system's
  assertion: it is shown as "reported hostile · TAK", weighted in the threat score as a separate,
  visible factor, and never merged into a known friendly track.
- Strata publishes its own fused picture as CoT so ATAK/WinTAK users see QRT positions and tracks of
  interest. Tracks that Strata only knows from another system are not sent back to it.
- UAS telemetry is received only; Strata never sends commands to a vehicle.

## Degraded operation

- Every sensor and feed has a health state; silence beyond its expected interval raises a sensor-outage
  alert and shows on the timeline. Incidents list the sensors that were not reporting.
- The server runs fully offline (embedded or on-premises PostgreSQL, local models, no map tiles or
  cloud services). Adapters queue messages while the server is unreachable and send them, in order,
  when it returns; beyond the queue bound the oldest are dropped and counted.
