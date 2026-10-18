import { createHmac, timingSafeEqual } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';

/**
 * The audit chain's head, written to a file outside the database after each record. A database administrator can
 * rewrite the chain and recompute every hash, but cannot change the anchor file, when it is kept on a store the
 * database account cannot write (a write-once volume, or a host that only receives the lines). With a key, each line
 * carries an HMAC, so a copy of the file cannot be extended by someone without the key. The file is opened for append
 * only; keep it on storage that enforces that too.
 */
export interface AnchorLine {
  seq: number;
  hash: string;
  t: number;
  mac?: string;
}

export class AuditAnchor {
  constructor(
    readonly file: string,
    private readonly key: Buffer | null,
  ) {}

  private macOf(seq: number, hash: string, t: number): string | undefined {
    return this.key ? createHmac('sha256', this.key).update(`${seq}|${hash}|${t}`).digest('hex') : undefined;
  }

  /** Appends one line and waits for it to reach the disk. A failure here fails the audit write that caused it. */
  async record(seq: number, hash: string, t: number): Promise<void> {
    const mac = this.macOf(seq, hash, t);
    const line: AnchorLine = mac ? { seq, hash, t, mac } : { seq, hash, t };
    const handle = await open(this.file, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(line)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async exists(): Promise<boolean> {
    return access(this.file).then(() => true, () => false);
  }

  /** The lines as written; a line that does not parse is reported by verifyAnchors, not skipped. */
  async read(): Promise<{ lines: AnchorLine[]; malformed: number[] }> {
    if (!(await this.exists())) return { lines: [], malformed: [] };
    const lines: AnchorLine[] = [];
    const malformed: number[] = [];
    const raw = (await readFile(this.file, 'utf8')).split('\n');
    raw.forEach((text, i) => {
      if (!text) return;
      try {
        const v = JSON.parse(text) as AnchorLine;
        if (!Number.isSafeInteger(v.seq) || typeof v.hash !== 'string' || !Number.isSafeInteger(v.t)) throw new Error('shape');
        lines.push(v);
      } catch {
        malformed.push(i + 1);
      }
    });
    return { lines, malformed };
  }

  /** Whether a line's MAC is the one this key produces. Without a key, lines carry no MAC and every line passes. */
  macMatches(line: AnchorLine): boolean {
    if (!this.key) return true;
    if (!line.mac) return false;
    const expected = Buffer.from(this.macOf(line.seq, line.hash, line.t)!, 'hex');
    const given = Buffer.from(line.mac, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}

export interface AnchorCheck {
  ok: boolean;
  anchors: number;
  lastSeq: number | null;
  problems: string[];
}

/**
 * Checks the anchor lines against the chain as it is now. Records after the last anchor are not yet anchored, which is
 * normal. An anchored record that is missing, has a different hash, or an anchor line whose MAC does not verify is a
 * problem; so is an anchor past the end of the chain (records were removed from the end).
 */
export function verifyAnchors(
  records: { seq: number; hash: string }[],
  anchor: { lines: AnchorLine[]; malformed: number[] },
  macMatches: (line: AnchorLine) => boolean,
): AnchorCheck {
  const problems: string[] = [];
  for (const n of anchor.malformed) problems.push(`anchor line ${n} does not parse`);
  const bySeq = new Map(records.map((r) => [r.seq, r.hash]));
  const head = records.reduce((m, r) => Math.max(m, r.seq), 0);
  let prev = 0;
  for (const line of anchor.lines) {
    if (!macMatches(line)) problems.push(`anchor ${line.seq}: the MAC does not verify`);
    if (line.seq <= prev) problems.push(`anchor ${line.seq}: not after anchor ${prev}`);
    prev = Math.max(prev, line.seq);
    if (line.seq > head) {
      problems.push(`anchor ${line.seq} is past the end of the chain (head ${head}): records were removed`);
      continue;
    }
    const got = bySeq.get(line.seq);
    if (got === undefined) problems.push(`anchored record ${line.seq} is missing`);
    else if (got !== line.hash) problems.push(`anchored record ${line.seq} was rewritten`);
  }
  return { ok: problems.length === 0, anchors: anchor.lines.length, lastSeq: anchor.lines.length ? prev : null, problems };
}
