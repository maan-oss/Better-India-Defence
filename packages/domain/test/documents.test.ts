import { describe, expect, it } from 'vitest';
import { ingestText, parseCsv, MAX_DOCUMENT_CHARS } from '../src/documents/ingest.ts';

describe('CSV parsing', () => {
  it('splits fields, keeps quoted commas, line breaks and doubled quotes', () => {
    expect(parseCsv('a,b,c\n1,"x, y",3\n4,"line\nbreak","say ""hi"""\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', '3'],
      ['4', 'line\nbreak', 'say "hi"'],
    ]);
  });

  it('refuses a quoted field that is never closed', () => {
    expect(() => parseCsv('a,"open\n1,2')).toThrow(/not closed/);
  });

  it('keeps empty trailing fields, and ignores blank lines', () => {
    expect(parseCsv('a,b\n1,\n\n2,3\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['2', '3'],
    ]);
  });
});

describe('ingesting a document', () => {
  it('accepts text and Markdown as they are, with CRLF line endings made plain', () => {
    expect(ingestText('text', 'line one\r\nline two')).toEqual({ text: 'line one\nline two', rows: null, problems: [] });
    expect(ingestText('markdown', '# Title\n\n- item').problems).toEqual([]);
  });

  it('refuses binary data, and a document longer than the limit', () => {
    expect(ingestText('text', 'abc\u0000def').problems[0]).toMatch(/binary/);
    expect(ingestText('text', 'x'.repeat(MAX_DOCUMENT_CHARS + 1)).problems[0]).toMatch(/longer than/);
  });

  it('counts the rows of a CSV without the header, and reports each ragged row', () => {
    expect(ingestText('csv', 'id,name\n1,pump\n2,fan\n')).toEqual({ text: 'id,name\n1,pump\n2,fan\n', rows: 2, problems: [] });
    const ragged = ingestText('csv', 'id,name,site\n1,pump\n2,fan,north,extra\n');
    expect(ragged.problems).toEqual(['row 2 has 2 fields; the header has 3', 'row 3 has 4 fields; the header has 3']);
  });

  it('refuses an empty CSV and an unclosed quote in a CSV', () => {
    expect(ingestText('csv', '\n\n').problems).toEqual(['the CSV has no rows']);
    expect(ingestText('csv', 'a,"b\n1,2').problems[0]).toMatch(/not closed/);
  });
});
