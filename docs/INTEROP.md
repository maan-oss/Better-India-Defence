# Interoperability

How equipment and other systems connect to Strata. Everything enters through one versioned ingest API
(`strata.ingest/v1`, see `packages/domain/src/schemas/ingest.ts`), authenticated with the service token,
from a sensor id registered for the site (Site setup → Data feeds, or Live Cameras for cameras).

| Source | Protocol | Path | Becomes |
|---|---|---|---|
| IP cameras, encoders, VMS re-streams | RTSP / RTSPS / HTTP(S) MJPEG, recorded files | built into the server (ffmpeg) | `camera.detections`, face sightings, frames |
| GPS handsets, vehicle AVL | NMEA 0183 (GGA, RMC) over UDP / TCP / serial | `strata-adapter` | `gps.position` (cooperative) |
| UAS ground stations, autopilots | MAVLink v1/v2 (receive-only) | `strata-adapter` | `drone.telemetry` |
| ATAK / WinTAK / TAK Server, other C2 | Cursor-on-Target XML over UDP / multicast / TCP | `strata-adapter`, or `POST /api/interop/cot` | `external.track` |
| Strata → ATAK / C2 | Cursor-on-Target | `strata-adapter` (`cotOut`), or `GET /api/interop/cot` | CoT events of the fused picture |
| Anything else | JSON over HTTPS | `POST /api/ingest/batch` | any ingest kind |

## Running the adapter

```bash
npm run build                      # or use the Docker image (packages/adapters/dist/cli.js)
export STRATA_INGEST_URL=http://127.0.0.1:4000 STRATA_SERVICE_TOKEN=…
node packages/adapters/dist/cli.js adapters.json
# Docker: put adapters.json next to docker-compose.yml, then
docker compose --profile adapters up -d
```

`packages/adapters/adapters.example.json` shows every option. Each listener has a `protocol` (`nmea`,
`mavlink`, `cot`) and a `transport`:

- `{"type": "udp", "port": 10110}` — optional `bind`, `multicast` group and `multicastInterface`
- `{"type": "tcp-client", "host": "10.1.2.3", "port": 8087}` — reconnects with backoff
- `{"type": "tcp-server", "port": 5000}` — many senders
- `{"type": "file", "path": "/dev/ttyUSB0"}` — a serial device (set the line speed first, e.g.
  `stty -F /dev/ttyUSB0 4800 raw`), or a recorded log with `bytesPerSecond` for replay

The adapter batches messages, retries with capped backoff while the server is unreachable (bounded
queue; overflow is dropped and counted), and prints per-listener counters every minute (received,
emitted, rejected with the last reason).

### NMEA 0183

- GGA and RMC from any talker (GP, GN, GL, GA, BD). Checksums are verified when present
  (`requireChecksum: true` rejects sentences without one). A GGA and RMC of the same second are merged
  (altitude and HDOP from GGA; date, speed and course from RMC).
- Accuracy is estimated as HDOP × a nominal error for the fix type (autonomous 4 m, DGPS 1.5 m, RTK
  float 0.3 m, RTK fixed 0.02 m).
- One receiver per port: set `entity`. AVL forwarders that prefix each line with a unit id
  (`QRT1,$GPRMC,…` or `QRT1:$GPRMC,…`): map ids in `entities`. Unmapped units are rejected and counted.

### MAVLink

- Frames are verified with the per-message CRC_EXTRA. Decoded: HEARTBEAT, SYS_STATUS, ATTITUDE,
  GLOBAL_POSITION_INT, VFR_HUD, GIMBAL_DEVICE_ATTITUDE_STATUS. Other messages are skipped. Signed frames
  are accepted, but the signature is not verified.
- Map MAVLink system ids to sensor ids in `vehicles` (`"1": {"sensorId": "UAV1", "callsign": "NETRA-1"}`)
  and register the sensor as a *UAS telemetry* feed.
- Flight modes (ArduPilot, PX4) are mapped to docked / patrol / transit / loiter / rtb; link quality comes
  from sequence-number gaps.
- **Receive-only.** The adapter never transmits to a vehicle. Point it at a telemetry *forward* from the
  ground station (e.g. a QGroundControl or Mission Planner UDP output) rather than at the radio link.

### Cursor-on-Target

- Inbound `a-*` (atom) events become external tracks. Affiliation comes from the MIL-STD-2525 letter
  (f/a friend, h/j/k hostile, s suspect, n neutral, p pending, u unknown) and the category from the
  battle dimension and function (air → aircraft or drone; ground equipment/vehicles → vehicle; infantry
  → person; sea → vessel). `ce`/`hae` of 9999999 ("unknown") are treated as unknown. Other event types
  (`b-`, `t-`, `u-`) are ignored. DTDs and entity declarations are refused.
- Friendly reports fuse as cooperative entities. Other reports keep the source's affiliation as an
  attributed assertion ("reported hostile · TAK") that weights the threat score as a visible factor;
  they are never merged into a known friendly track.
- Stale reports (past their `stale` time) are stored as evidence but do not move or sustain a track.
- Outbound (`cotOut` in the adapter config, or `GET /api/interop/cot`): confirmed and coasting tracks as
  CoT, uid `strata.<site>.<track>`, with the platform's classification, confidence and sources in the
  remarks. Tracks Strata knows only from external feeds are not re-published, and inbound events with
  a `strata.` uid are ignored, so two systems cannot echo a track back and forth.
- `POST /api/interop/cot?sensorId=EXT1` (service token, `content-type: application/xml`) accepts one
  or more events in the body for systems that push over HTTP.

## Writing a new adapter

Post batches of envelopes to `/api/ingest/batch` with `Authorization: Bearer $STRATA_SERVICE_TOKEN`:

```json
{ "messages": [ {
  "schema": "strata.ingest/v1", "messageId": "radar1:48213", "sensorId": "R01", "adapter": "asterix.cat062.v1",
  "seq": 48213, "observedAt": 1791108313410, "sentAt": 1791108313500,
  "kind": "radar.track", "payload": { … } } ] }
```

- `messageId` must be unique per message; re-sending the same id is de-duplicated, so retries are safe.
- `observedAt` is the measurement time from the sensor's clock. Messages more than 30 s in the future
  or older than 7 days are rejected with the reason (see System Health → dead letters).
- Use `packages/adapters/src/client.ts` (queueing, batching, backoff) as the starting point.

Adapters for radar (ASTERIX), passive RF, PIDS/fence controllers, LiDAR and building management systems
are not written yet.
