import { z } from 'zod';

/**
 * Wire format accepted by the ingestion API. Every adapter — simulated or physical — speaks this envelope.
 * Positions are WGS84 geodetic; the platform normalises into its local ENU frame on ingestion.
 */
export const INGEST_SCHEMA_VERSION = 'strata.ingest/v1';

export const geodeticSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  alt: z.number().finite().min(-500).max(60000),
});

const enuVelocity = z.object({ ve: z.number().finite(), vn: z.number().finite(), vu: z.number().finite() });

const sensorIdSchema = z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/, 'sensorId must be upper-case alphanumeric');

export const radarTrackPayload = z.object({
  scanId: z.number().int().nonnegative(),
  plots: z
    .array(
      z.object({
        localTrackId: z.string().min(1).max(32),
        position: geodeticSchema,
        velocity: enuVelocity,
        rangeM: z.number().nonnegative(),
        azimuthDeg: z.number().min(0).max(360),
        elevationDeg: z.number().min(-90).max(90),
        rcsDbsm: z.number().min(-60).max(60),
        confidence: z.number().min(0).max(1),
        sigma: z.object({ rangeM: z.number().positive(), azDeg: z.number().positive(), elDeg: z.number().positive() }),
      }),
    )
    .max(512),
});

export const rfDetectionPayload = z.object({
  emissions: z
    .array(
      z.object({
        emitterId: z.string().min(1).max(32),
        centerFrequencyMHz: z.number().positive().max(100000),
        bandwidthMHz: z.number().positive().max(1000),
        rssiDbm: z.number().min(-160).max(30),
        modulation: z.string().max(32),
        protocolClass: z.string().max(64),
        region: z.object({ center: geodeticSchema, radiusM: z.number().positive().max(10000) }),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(64),
});

export const cameraPoseSchema = z.object({
  position: geodeticSchema,
  headingDeg: z.number().min(-360).max(720),
  pitchDeg: z.number().min(-90).max(90),
  hfovDeg: z.number().positive().max(179),
  widthPx: z.number().int().positive().max(16384),
  heightPx: z.number().int().positive().max(16384),
});

export const DETECTION_CLASSES = ['person', 'vehicle', 'drone', 'bird', 'aircraft', 'debris', 'unknown'] as const;

export const cameraDetectionsPayload = z.object({
  frameId: z.string().min(1).max(96),
  pose: cameraPoseSchema,
  detections: z
    .array(
      z.object({
        localTrackId: z.string().min(1).max(32),
        cls: z.enum(DETECTION_CLASSES),
        bbox: z.tuple([z.number(), z.number(), z.number().nonnegative(), z.number().nonnegative()]),
        score: z.number().min(0).max(1),
        /** Appearance descriptor from the site re-identification model (synthetic in the test facility). */
        appearance: z.array(z.number().finite()).length(16).optional(),
        /** Image-quality score of the head region (0–1). No facial recognition is performed by the platform. */
        faceQuality: z.number().min(0).max(1).optional(),
        sharpness: z.number().min(0).max(1),
        isStatic: z.boolean().optional(),
      }),
    )
    .max(256),
});

export const droneTelemetryPayload = z.object({
  callsign: z.string().max(32),
  position: geodeticSchema,
  velocity: enuVelocity,
  attitude: z.object({ headingDeg: z.number(), pitchDeg: z.number(), rollDeg: z.number() }),
  gimbal: z.object({ headingDeg: z.number(), pitchDeg: z.number(), hfovDeg: z.number().positive().max(179) }),
  /** Omitted when the vehicle does not report it. */
  batteryPct: z.number().min(0).max(100).optional(),
  mode: z.enum(['docked', 'patrol', 'transit', 'loiter', 'survey', 'rtb']),
  linkQuality: z.number().min(0).max(1),
});

export const gpsPositionPayload = z.object({
  entityId: z.string().min(1).max(32),
  entityKind: z.enum(['person', 'vehicle']),
  callsign: z.string().max(48),
  role: z.string().max(48),
  status: z.enum(['available', 'busy', 'responding', 'off_duty', 'sos']),
  position: geodeticSchema,
  accuracyM: z.number().positive().max(1000),
  speedMps: z.number().min(0).max(200).optional(),
  headingDeg: z.number().min(0).max(360).optional(),
});

export const lidarScanPayload = z.object({
  scanId: z.string().min(1).max(64),
  sensorPosition: geodeticSchema,
  mediaId: z.string().min(1).max(96),
  pointCount: z.number().int().nonnegative(),
  rangeM: z.number().positive(),
  durationMs: z.number().nonnegative(),
  frame: z.enum(['site-enu']),
});

export const imageryCapturePayload = z.object({
  captureId: z.string().min(1).max(64),
  mediaId: z.string().min(1).max(96),
  acquiredAt: z.number().int().positive(),
  gsdM: z.number().positive(),
  footprint: z.object({ sw: geodeticSchema, ne: geodeticSchema }),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  cloudCoverPct: z.number().min(0).max(100),
  sunElevationDeg: z.number().min(-90).max(90),
  processingLevel: z.enum(['L1', 'L2', 'L3']),
});

export const sensorHealthPayload = z.object({
  status: z.enum(['ok', 'degraded', 'fault', 'offline']),
  uptimeS: z.number().nonnegative(),
  temperatureC: z.number().optional(),
  message: z.string().max(240).optional(),
  metrics: z.record(z.string().max(48), z.number().finite()).optional(),
});

export const infrastructureStatePayload = z.object({
  assetId: z.string().min(1).max(48),
  assetKind: z.enum(['gate', 'fence', 'power', 'network', 'lighting']),
  state: z.string().min(1).max(32),
  alarm: z.boolean(),
  detail: z.string().max(240).optional(),
  position: geodeticSchema.optional(),
});

export const AFFILIATIONS = ['friend', 'hostile', 'suspect', 'neutral', 'unknown', 'pending'] as const;
export const EXTERNAL_CATEGORIES = ['person', 'vehicle', 'aircraft', 'drone', 'vessel', 'unknown'] as const;

/**
 * A track reported by another system (C2 interop: Cursor-on-Target, a unit BMS, a neighbouring site's
 * picture). The affiliation is the reporting system's assertion and is shown as such; friendly reports
 * fuse as cooperative entities, everything else as non-cooperative measurements.
 */
export const externalTrackPayload = z.object({
  system: z.string().min(1).max(32),
  uid: z.string().min(1).max(96),
  callsign: z.string().max(64).optional(),
  affiliation: z.enum(AFFILIATIONS),
  category: z.enum(EXTERNAL_CATEGORIES),
  position: geodeticSchema,
  /** Circular error (1-σ, metres) reported by the source; 9999999 in CoT means "unknown". */
  ceM: z.number().positive().max(100000),
  courseDeg: z.number().min(0).max(360).optional(),
  speedMps: z.number().min(0).max(1000).optional(),
  /** Source type string, kept for the evidence inspector (e.g. CoT "a-h-G-U-C"). */
  type: z.string().max(64).optional(),
  /** Report validity end (ms epoch); the platform does not extend a stale report. */
  staleAt: z.number().int().positive().optional(),
  remarks: z.string().max(500).optional(),
});

const base = {
  schema: z.literal(INGEST_SCHEMA_VERSION),
  messageId: z.string().min(6).max(96),
  sensorId: sensorIdSchema,
  adapter: z.string().min(3).max(64),
  seq: z.number().int().nonnegative(),
  observedAt: z.number().int().positive(),
  sentAt: z.number().int().positive(),
};

export const ingestEnvelopeSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('radar.track'), payload: radarTrackPayload }),
  z.object({ ...base, kind: z.literal('rf.detection'), payload: rfDetectionPayload }),
  z.object({ ...base, kind: z.literal('camera.detections'), payload: cameraDetectionsPayload }),
  z.object({ ...base, kind: z.literal('drone.telemetry'), payload: droneTelemetryPayload }),
  z.object({ ...base, kind: z.literal('gps.position'), payload: gpsPositionPayload }),
  z.object({ ...base, kind: z.literal('lidar.scan'), payload: lidarScanPayload }),
  z.object({ ...base, kind: z.literal('imagery.capture'), payload: imageryCapturePayload }),
  z.object({ ...base, kind: z.literal('sensor.health'), payload: sensorHealthPayload }),
  z.object({ ...base, kind: z.literal('infrastructure.state'), payload: infrastructureStatePayload }),
  z.object({ ...base, kind: z.literal('external.track'), payload: externalTrackPayload }),
]);

export type IngestEnvelope = z.infer<typeof ingestEnvelopeSchema>;
export type IngestKind = IngestEnvelope['kind'];
export type RadarTrackPayload = z.infer<typeof radarTrackPayload>;
export type RfDetectionPayload = z.infer<typeof rfDetectionPayload>;
export type CameraDetectionsPayload = z.infer<typeof cameraDetectionsPayload>;
export type CameraDetection = CameraDetectionsPayload['detections'][number];
export type DroneTelemetryPayload = z.infer<typeof droneTelemetryPayload>;
export type GpsPositionPayload = z.infer<typeof gpsPositionPayload>;
export type LidarScanPayload = z.infer<typeof lidarScanPayload>;
export type ImageryCapturePayload = z.infer<typeof imageryCapturePayload>;
export type SensorHealthPayload = z.infer<typeof sensorHealthPayload>;
export type InfrastructureStatePayload = z.infer<typeof infrastructureStatePayload>;
export type ExternalTrackPayload = z.infer<typeof externalTrackPayload>;
export type Affiliation = (typeof AFFILIATIONS)[number];
export type DetectionClass = (typeof DETECTION_CLASSES)[number];

export const ingestBatchSchema = z.object({ messages: z.array(z.unknown()).min(1).max(5000) });
