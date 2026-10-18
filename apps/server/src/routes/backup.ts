import type { FastifyInstance } from 'fastify';
import { join, relative } from 'node:path';
import type { Platform } from '../platform.ts';
import { createBackup } from '../backup/backup.ts';
import { audit, requirePerm } from '../http/guards.ts';

/** A backup of the running installation, written under DATA_DIR/backups. Restore is done offline (backup/cli.ts). */
export function registerBackup(app: FastifyInstance, p: Platform): void {
  app.post('/api/admin/backup', { preHandler: requirePerm('admin.config') }, async (req) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(p.cfg.dataDir, 'backups', stamp);
    const m = await createBackup(p.db, p.cfg.dataDir, dir, p.anchor.file);
    await audit(p, req, 'backup_created', stamp, { files: m.files.length, auditHead: m.auditHead?.seq ?? null });
    return {
      backup: relative(p.cfg.dataDir, dir),
      createdAt: m.createdAt,
      files: m.files.length,
      tables: m.tables,
      auditHead: m.auditHead,
    };
  });
}
