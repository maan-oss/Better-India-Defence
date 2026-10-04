import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { FACILITY } from '@strata/domain';
import { SCENARIO_INFO } from '@strata/simulator';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import { openDb, type Db } from './db/client.ts';
import { migrate } from './db/migrate.ts';
import { LocalObjectStore } from './storage/objectStore.ts';
import { AuditLog } from './audit/audit.ts';
import { Metrics } from './metrics.ts';
import { LiveHub } from './live/hub.ts';
import { SensorMonitor } from './ingest/sensorMonitor.ts';
import { FusionService } from './fusion/fusionService.ts';
import { WorldMemory } from './world/worldMemory.ts';
import { AlertEngine } from './alerts/alertEngine.ts';
import { IncidentService } from './incidents/incidentService.ts';
import { WorkerPool } from './reconstruction/workerPool.ts';
import { ReconstructionService } from './reconstruction/service.ts';
import { MediaService } from './media/mediaService.ts';
import { CoverageService } from './world/coverage.ts';
import { IngestPipeline } from './ingest/pipeline.ts';
import { ReplayQueries } from './replay/queries.ts';
import { CopilotService } from './copilot/copilot.ts';
import { AuthService } from './auth/authService.ts';
import { HandoffService } from './handoff/handoffService.ts';
import { VisionService } from './vision/visionService.ts';
import { IdentityService } from './identity/identityService.ts';
import { EvidenceService } from './evidence/evidenceService.ts';
import { CameraService } from './cameras/cameraService.ts';

/** Composition root: constructs and wires every service, restores persisted state, starts timers. */
export class Platform {
  readonly metrics = new Metrics();
  readonly hub = new LiveHub(this.metrics);
  db!: Db;
  audit!: AuditLog;
  store!: LocalObjectStore;
  sensors!: SensorMonitor;
  fusion!: FusionService;
  world!: WorldMemory;
  alerts!: AlertEngine;
  incidents!: IncidentService;
  pool!: WorkerPool;
  media!: MediaService;
  recon!: ReconstructionService;
  coverage!: CoverageService;
  ingest!: IngestPipeline;
  replay!: ReplayQueries;
  copilot!: CopilotService;
  auth!: AuthService;
  handoff!: HandoffService;
  vision!: VisionService;
  identity!: IdentityService;
  evidence!: EvidenceService;
  cameras!: CameraService;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    readonly cfg: Config,
    readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    const cfg = this.cfg;
    this.db = await openDb(cfg.DATABASE_URL, cfg.dataDir);
    this.log.info({ engine: this.db.engine }, 'database connected');
    await migrate(this.db, this.log);
    await this.seedRegistry();
    this.store = new LocalObjectStore(join(cfg.dataDir, 'objects'), cfg.STORAGE_ENCRYPTION_KEY ? Buffer.from(cfg.STORAGE_ENCRYPTION_KEY, 'hex') : null);
    this.audit = new AuditLog(this.db);
    this.auth = new AuthService(this.db, cfg.SESSION_TTL_HOURS);
    await this.auth.ensureUsers(cfg.STRATA_DEMO_USERS === 'true', cfg.STRATA_DEMO_PASSWORD, cfg.STRATA_ADMIN_PASSWORD);
    this.sensors = new SensorMonitor(this.db, this.hub);
    await this.sensors.load();
    this.fusion = new FusionService(this.db, this.hub, this.metrics);
    const restored = await this.fusion.restore();
    this.world = new WorldMemory(this.db, this.hub);
    await this.world.load();
    this.alerts = new AlertEngine(this.db, this.hub);
    await this.alerts.load();
    this.incidents = new IncidentService(this.db, this.hub, this.alerts);
    this.pool = new WorkerPool(2);
    this.media = new MediaService(this.db, this.store, cfg.SIM_URL, cfg.STRATA_SERVICE_TOKEN);
    this.recon = new ReconstructionService(this.db, this.pool, this.world, this.media, this.fusion, this.hub, this.log);
    this.coverage = new CoverageService(this.db, this.pool, this.world, join(cfg.dataDir, 'cache'));
    void this.coverage.init().then(() => this.log.info('camera visibility matrix ready'));
    this.ingest = new IngestPipeline(this.db, this.log, this.metrics, this.hub, this.sensors, this.fusion, this.world, this.alerts, this.recon);
    await this.ingest.load();
    this.replay = new ReplayQueries(this.db, this.world);
    this.copilot = new CopilotService(this.db, this.log, this.fusion, this.replay, this.coverage, this.incidents, this.alerts, this.sensors, { apiKey: cfg.ANTHROPIC_API_KEY, model: cfg.COPILOT_MODEL, provider: cfg.COPILOT_PROVIDER });
    this.handoff = new HandoffService(this.db);
    this.vision = new VisionService();
    this.identity = new IdentityService(this.db, this.store, this.alerts, this.hub);
    await this.identity.load();
    this.evidence = new EvidenceService(this.db, this.store, this.vision, this.identity, this.hub, this.audit, this.log);
    void this.evidence.resume();
    const importDir = resolve(cfg.STRATA_IMPORT_DIR ?? join(cfg.dataDir, 'import'));
    await mkdir(importDir, { recursive: true });
    this.cameras = new CameraService(this.db, this.log, this.ingest, this.vision, this.identity, this.evidence, this.store, cfg.STORAGE_ENCRYPTION_KEY ? Buffer.from(cfg.STORAGE_ENCRYPTION_KEY, 'hex') : null, importDir);
    this.ingest.supersede = (sid, adapter) => this.cameras.superseded(sid, adapter);
    await this.cameras.load();
    if (!this.vision.ffmpeg) this.log.warn('ffmpeg not found: video evidence and network cameras are unavailable (images still work)');
    // Face-data retention: unmatched sightings are purged after the configured period.
    this.timers.push(
      setInterval(() => {
        void this.identity
          .purge()
          .then((n) => n && this.log.info({ purged: n }, 'face retention purge'))
          .catch((e: unknown) => this.log.error({ err: e instanceof Error ? e.message : String(e) }, 'face purge failed'));
      }, 3600_000),
    );

    // Wiring.
    this.fusion.listeners.push((events, snaps) => this.alerts.onTracks(events, snaps));
    this.world.changeListeners.push((c) => this.alerts.onChange(c));
    if (cfg.AUTO_INCIDENTS === 'true')
      this.alerts.criticalListeners.push(async (a) => {
        const inc = await this.incidents.createFromAlert(a);
        if (inc) this.log.info({ incident: inc.code, alert: a.id }, 'incident opened from critical alert');
      });
    this.log.info({ restoredTracks: restored, dataClock: this.ingest.dataClock ? new Date(this.ingest.dataClock).toISOString() : null }, 'state restored');

    // Live clock: when near real time, advance derived state on wall-clock so silence and track loss are
    // detected even if no traffic arrives. Never advances during historical (fast-forward) ingestion.
    this.timers.push(
      setInterval(() => {
        const now = Date.now();
        const clock = this.ingest.dataClock;
        if (clock > 0 && now - clock < 120_000 && this.ingest.queueDepth === 0) {
          void this.ingest
            .tick(now - 1500)
            .then(() => this.fusion.publishLive(this.liveEdge()))
            .catch((e: unknown) => this.log.error({ err: e instanceof Error ? e.message : String(e) }, 'live advance failed'));
        } else if (clock > 0) this.fusion.publishLive(clock);
        this.hub.publish({ type: 'tick', serverTime: now, liveEdge: this.liveEdge() });
      }, 1000),
    );
  }

  liveEdge(): number {
    const now = Date.now();
    const c = this.ingest?.dataClock ?? 0;
    return c > 0 && now - c < 120_000 ? Math.min(now, Math.max(c, now - 1500)) : c;
  }

  private async seedRegistry(): Promise<void> {
    const now = Date.now();
    const f = FACILITY;
    await this.db.query(
      `INSERT INTO facilities (id, name, origin_lat, origin_lon, origin_alt, half_extent_m, definition, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (id) DO UPDATE SET definition = EXCLUDED.definition, name = EXCLUDED.name`,
      [f.id, f.name, f.origin.lat, f.origin.lon, f.origin.alt, f.halfExtentM, JSON.stringify({ buildings: f.buildings.length, roads: f.roads.length }), now],
    );
    for (const z of f.zones)
      await this.db.query('INSERT INTO zones (id, facility_id, name, kind, restricted, polygon) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO NOTHING', [z.id, f.id, z.name, z.kind, z.restricted, JSON.stringify(z.polygon)]);
    for (const s of f.sensors)
      await this.db.query('INSERT INTO sensors (id, facility_id, kind, name, segment, definition, registered_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (id) DO UPDATE SET definition = EXCLUDED.definition', [s.id, f.id, s.kind, s.name, s.segment, JSON.stringify(s), now]);
    for (const s of SCENARIO_INFO)
      await this.db.query('INSERT INTO simulation_scenarios (key, name, description, duration_min, exercises) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description', [s.key, s.name, s.description, s.durationMin, JSON.stringify(s.exercises)]);
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.cameras?.stopAll();
    this.hub.close();
    await this.pool?.close();
    await this.vision?.close();
    await this.db?.close();
  }
}
