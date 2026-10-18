// Command line for backup and restore. Run it with the service stopped: the embedded database is opened by one process
// at a time. A running service can also write a backup through POST /api/admin/backup.
//   node apps/server/dist/backup.js backup <directory>     write a backup of DATA_DIR (and DATABASE_URL, if set)
//   node apps/server/dist/backup.js restore <directory>    load a backup into an empty DATA_DIR
import { resolve } from 'node:path';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/client.ts';
import { migrate } from '../db/migrate.ts';
import { createLogger } from '../logger.ts';
import { createBackup, restoreBackup } from './backup.ts';

const [cmd, target] = process.argv.slice(2);
if ((cmd !== 'backup' && cmd !== 'restore') || !target) {
  console.error('usage: backup.js backup|restore <directory>');
  process.exit(2);
}

const cfg = loadConfig(process.env);
const log = createLogger(cfg.LOG_LEVEL, false);
const db = await openDb(cfg.DATABASE_URL, cfg.dataDir);
try {
  if (cmd === 'backup') {
    await migrate(db, log);
    const m = await createBackup(db, cfg.dataDir, resolve(target));
    console.log(`backup written to ${resolve(target)}: ${m.files.length} files, ${Object.values(m.tables).reduce((a, b) => a + b, 0)} rows, audit head ${m.auditHead?.hash.slice(0, 16) ?? 'none'}`);
  } else {
    const s = await restoreBackup(resolve(target), db, cfg.dataDir, log);
    console.log(`restored ${s.tables} tables, ${s.rows} rows, ${s.objects} objects; audit chain verified (${s.auditRecords} records)`);
  }
} finally {
  await db.close();
}
