# Backup and recovery

A backup is a directory holding every table of the database and the object store (media, evidence and imagery),
with a manifest of the SHA-256 and size of every file in it. Restore loads a backup into an empty installation and
checks the audit chain before and after loading it. This procedure was exercised on a demonstration installation of
about 1.8 GB (1.5 million rows, 251 objects): backup took 38 seconds, restore took 86 seconds, and the restored
installation started, signed in and reported `ok` from the audit verification.

## Making a backup

**From a running service** (administrators only, audited as `backup_created`):

    POST /api/admin/backup

The backup is written to `DATA_DIR/backups/<UTC time>/`. The database is read in one transaction, so the snapshot is
consistent; the service keeps running. Objects are copied after the snapshot, so every object a row names is on disk.

**From the command line** (stop the service first when the database is embedded, since one process may open it):

    DATA_DIR=/srv/strata/data npm run backup -- /srv/backups/strata-2026-10-18

Copy the backup directory off the host. Keep `STORAGE_ENCRYPTION_KEY` and the release signing key separately from the backup: encrypted objects cannot be
read without the key they were encrypted with.

## Restoring

1. Stop the service that uses the target directory. Restore into a **new, empty** `DATA_DIR`; restore refuses a
   target that already holds rows or objects.
2. Run the restore:

       DATA_DIR=/srv/strata/data-restored npm run restore -- /srv/backups/strata-2026-10-18

   Restore first verifies the backup: every file must match the manifest, and no unlisted file may be present. Then it
   checks the audit chain in the backup and that it ends at the head recorded in the manifest. Only then are rows
   written, in one transaction. Afterwards the live chain is verified again.
3. Start the service on the restored directory and check `GET /api/audit/verify` reports `ok: true`.

If a step fails, rows may already be written: discard the target directory and restore again. Never restore over a
live directory.

## What a failure means

| Message | Meaning | Action |
|---|---|---|
| `missing`, `content differs`, `not in the backup manifest` | The backup was changed or damaged after it was written | Use another copy |
| `the backup's audit chain does not verify at record N` | Records were altered, even if the manifest was recomputed to match | Treat as tampering; investigate; use an earlier backup |
| `the backup audit chain does not end at the recorded head` | Records were added or removed at the end | As above |
| `the target database is not empty` | The target already holds data | Use a new directory |
| `the backup was made with migrations [...]` | The build differs from the one that wrote the backup | Restore with the matching build, then upgrade |

## Limits

- The backup holds the whole database. High-volume telemetry tables (observations, ingest messages) dominate its size;
  schedule backups with that in mind and retain them by policy outside this tool.
- Backups are not encrypted by the tool. The database and any objects are written as they are stored. Put backups on
  encrypted storage.
- The manifest proves that a backup has not changed since it was written and that its audit chain is internally
  consistent. It does not prove that the chain is the one the installation wrote: an administrator with database
  access can rewrite the whole chain. The external anchor of the audit head (see `SECURITY.md`) is what closes that.
- The restore test runs on an embedded database. A PostgreSQL restore uses the same SQL path, and is not separately
  tested here.
- Restores have been run here only into a fresh directory on the same host.
