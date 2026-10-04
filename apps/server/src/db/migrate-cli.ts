import { loadConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { openDb } from './client.ts';
import { migrate } from './migrate.ts';

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL, true);
const db = await openDb(cfg.DATABASE_URL, cfg.dataDir);
const applied = await migrate(db, log);
log.info({ applied: applied.length, engine: db.engine }, 'migrations complete');
await db.close();
