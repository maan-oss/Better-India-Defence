import { parseCsv } from '../documents/ingest.ts';
import { AssetInput } from '../schemas/assets.ts';
import { mayCreateAt, type Subject } from '../policy/access.ts';

/**
 * Asset register import. A file is planned before anything is written: every row is checked against the same schema the
 * register enforces, against the tags already in use and within the file, and against the importer's clearance and
 * organisation. The plan lists every problem by row and column, so a file can be corrected in one pass.
 */
export const ASSET_IMPORT_COLUMNS = [
  'tag',
  'name',
  'category',
  'criticality',
  'zone_id',
  'manufacturer',
  'model',
  'serial',
  'commissioned_at',
  'warranty_until',
  'notes',
  'classification',
  'owner',
  'shared_with',
  'stock_quantity',
  'reorder_level',
  'stock_unit',
] as const;
const REQUIRED = ['tag', 'name', 'category', 'criticality'] as const;
export const MAX_IMPORT_ROWS = 2000;

export interface ImportProblem {
  /** The data row (1 is the first row after the header). Zero for a problem with the file as a whole. */
  row: number;
  column?: string;
  message: string;
}

export interface ImportPlan {
  rows: { row: number; input: AssetInput }[];
  problems: ImportProblem[];
}

/** A date in the file: a calendar day (2026-10-18) or an epoch in milliseconds. Anything else is a problem for the caller. */
function dateValue(v: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isNaN(t) ? null : t;
  }
  if (/^\d{10,13}$/.test(v)) return Number(v.length === 10 ? Number(v) * 1000 : Number(v));
  return null;
}

export function planAssetImport(text: string, opts: { existingTags: ReadonlySet<string>; subject: Subject }): ImportPlan {
  const problems: ImportProblem[] = [];
  let table: string[][];
  try {
    table = parseCsv(text.replace(/\r\n?/g, '\n'));
  } catch (e) {
    return { rows: [], problems: [{ row: 0, message: e instanceof Error ? e.message : 'the file does not parse' }] };
  }
  if (table.length === 0) return { rows: [], problems: [{ row: 0, message: 'the file is empty' }] };
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  for (const col of header) if (!(ASSET_IMPORT_COLUMNS as readonly string[]).includes(col)) problems.push({ row: 0, column: col, message: 'unknown column' });
  for (const col of REQUIRED) if (!header.includes(col)) problems.push({ row: 0, column: col, message: 'required column is missing' });
  if (new Set(header).size !== header.length) problems.push({ row: 0, message: 'a column is named more than once' });
  if (table.length - 1 > MAX_IMPORT_ROWS) problems.push({ row: 0, message: `the file has more than ${MAX_IMPORT_ROWS} rows` });
  if (problems.length) return { rows: [], problems };

  const rows: ImportPlan['rows'] = [];
  const tagsInFile = new Set<string>();
  table.slice(1, MAX_IMPORT_ROWS + 1).forEach((cells, i) => {
    const row = i + 1;
    if (cells.length === 1 && cells[0] === '') return; // a blank line is not a row
    if (cells.length !== header.length) {
      problems.push({ row, message: `has ${cells.length} fields; the header has ${header.length}` });
      return;
    }
    const get = (col: string): string | undefined => {
      const j = header.indexOf(col);
      if (j < 0) return undefined;
      const v = cells[j]!.trim();
      return v === '' ? undefined : v;
    };
    const before = problems.length;
    const dates: Record<string, number | null | undefined> = {};
    for (const col of ['commissioned_at', 'warranty_until'] as const) {
      const v = get(col);
      if (v === undefined) continue;
      dates[col] = dateValue(v);
      if (dates[col] === null) problems.push({ row, column: col, message: 'use a date (2026-10-18) or a time in milliseconds' });
    }
    const stockQuantity = get('stock_quantity');
    const candidate = {
      tag: get('tag'),
      name: get('name'),
      category: get('category'),
      criticality: get('criticality') === undefined ? undefined : Number(get('criticality')),
      zoneId: get('zone_id') ?? null,
      manufacturer: get('manufacturer') ?? null,
      model: get('model') ?? null,
      serial: get('serial') ?? null,
      commissionedAt: dates.commissioned_at ?? null,
      warrantyUntil: dates.warranty_until ?? null,
      notes: get('notes') ?? null,
      classification: get('classification'),
      owner: get('owner') ?? null,
      sharedWith: (get('shared_with') ?? '').split(';').map((s) => s.trim()).filter(Boolean),
      stock:
        stockQuantity === undefined
          ? undefined
          : { quantity: Number(stockQuantity), reorderLevel: Number(get('reorder_level') ?? 0), unit: get('stock_unit') ?? 'each' },
    };
    const parsed = AssetInput.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push({ row, column: String(issue.path[0] ?? ''), message: issue.message });
    }
    const tag = get('tag');
    if (tag) {
      if (tagsInFile.has(tag)) problems.push({ row, column: 'tag', message: `${tag} appears more than once in the file` });
      else if (opts.existingTags.has(tag)) problems.push({ row, column: 'tag', message: `tag ${tag} is already in use` });
      tagsInFile.add(tag);
    }
    if (parsed.success) {
      const input = parsed.data;
      if (!mayCreateAt(opts.subject, input.classification ?? 'UNCLASSIFIED')) problems.push({ row, column: 'classification', message: 'above your clearance' });
      if (input.owner && input.owner !== opts.subject.organisation && opts.subject.role !== 'administrator') {
        problems.push({ row, column: 'owner', message: 'only an administrator can import for another organisation' });
      }
    }
    if (problems.length === before && parsed.success) rows.push({ row, input: parsed.data });
  });
  return { rows, problems };
}
