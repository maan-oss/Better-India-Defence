/**
 * Document ingestion: plain text, Markdown and CSV. A document is checked before it is kept: it must be text (no NUL bytes,
 * valid lines), a CSV must parse with the same number of fields on every row, and the size is bounded. The stored text is
 * what full-text search reads, so the rules here are the rules for what can be found.
 */
export const DOCUMENT_KINDS = ['text', 'markdown', 'csv'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** How far an analyst has assessed a document's content. Set by someone other than the uploader. */
export const CONFIDENCE_LEVELS = ['unreviewed', 'probable', 'confirmed', 'disputed'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const MAX_DOCUMENT_CHARS = 1_000_000;

export interface Ingested {
  text: string;
  /** CSV only: the number of data rows (the header is not counted). */
  rows: number | null;
  problems: string[];
}

/** RFC 4180 field splitting: quoted fields may hold commas, line breaks and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (quoted) throw new Error('a quoted field is not closed');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Checks and normalises the text of a document of the given kind. */
export function ingestText(kind: DocumentKind, raw: string): Ingested {
  const problems: string[] = [];
  if (raw.length > MAX_DOCUMENT_CHARS) problems.push(`the document is longer than ${MAX_DOCUMENT_CHARS} characters`);
  if (raw.includes('\u0000')) problems.push('the document contains binary data (a NUL character); only text is accepted');
  const text = raw.replace(/\r\n?/g, '\n');
  if (problems.length) return { text, rows: null, problems };
  if (kind !== 'csv') return { text, rows: null, problems };
  try {
    const rows = parseCsv(text);
    if (rows.length === 0) return { text, rows: 0, problems: ['the CSV has no rows'] };
    const width = rows[0]!.length;
    rows.forEach((r, i) => {
      if (r.length !== width) problems.push(`row ${i + 1} has ${r.length} fields; the header has ${width}`);
    });
    return { text, rows: rows.length - 1, problems };
  } catch (e) {
    return { text, rows: null, problems: [e instanceof Error ? e.message : 'the CSV does not parse'] };
  }
}
