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

### Displays

- **Symbology.** Tracks are drawn with APP-6 / MIL-STD-2525-style frames: friend (blue rectangle),
  hostile (red diamond), suspect (orange diamond), unknown (yellow quatrefoil), neutral (green square);
  air tracks use the
  open-bottom half frames. The icon inside gives the function (infantry, vehicle, UAV, aircraft). A
  **dashed** frame means the object is not currently observed (coasting or lost): its position is the
  last confirmed one. A non-cooperative track is *unknown* until identified — the platform never marks
  anything hostile by itself; "hostile" only appears when another system reported it, and says so.
- **Colour means one thing each.** The interface itself is grey; colour on screen always means
  something. Blue is a friendly track. Red, orange, amber and green are status (critical → high →
  medium → normal), always shown with a shape or word as well, and red is kept for what needs action
  now. Teal marks *reconstructed* and violet *inferred* content. Zones, the fence, buildings and asset
  rings are drawn in neutral grey, so anything bright on the map is something to look at. See
  [DESIGN.md](DESIGN.md).
- **Map furniture.** MGRS grid (100 m lines, brighter 1 km index lines), compass (click for north-up),
  scale bar, and the grid reference and elevation under the cursor.
- **Night display.** User menu → *Night display (red light)*: the whole console, imagery and 3-D view in
  monochrome red to preserve dark adaptation.
- **Alert toasts.** New critical and high alerts appear top-right with *Show on map* and *Acknowledge*;
  critical ones stay until handled. If the live connection drops, a red banner says the picture is not
  updating.

### Gate and perimeter (operator / guard commander)

- **Camera wall** shows every camera: the site's cameras and the analysed live streams, in 1×1 to 4×4
  layouts with a guard tour that cycles pages; cameras with an active alert flash and sort first. Click a
  tile for its pose, stream health, recognised faces and actions.
- Each analysed stream shows with detections and recognised faces. A personnel member
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

### Field teams (QRT / patrol leader, operator role)

- Open **Field view** on a phone or tablet (the navigation moves to the bottom of the screen) and pick
  your team; the choice is remembered on the device.
- The current task shows the orders, grid reference, distance and bearing from your tracker's last fix,
  ETA, and one large button for the next status (acknowledge → en route → on scene → complete, with an
  outcome). Each step is logged; *on scene* is also set automatically within 35 m of the task.
- **Local picture**: north-up plot of everything within 600 m, the task location and a bearing line.
- **Contact report (SALUTE)**: Size, Activity, Location, Unit, Time, Equipment — goes to the duty log
  and raises a medium alert in the control room.
- **Request assistance**: press and hold for 1.5 s (so a stray tap cannot send it); raises a critical
  alert at your last known position with its own standing orders.

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
