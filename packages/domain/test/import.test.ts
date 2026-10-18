import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_ROWS, planAssetImport, type Subject } from '../src/index.ts';

const operator: Subject = { clearance: 'CONFIDENTIAL', organisation: 'logistics', role: 'operator' };
const none = new Set<string>();
const HEAD = 'tag,name,category,criticality,classification,owner,shared_with,commissioned_at';

describe('asset import plan', () => {
  it('accepts a valid file, mapping each column to the register\'s fields', () => {
    const plan = planAssetImport(`${HEAD}\nPUMP-1,Fuel pump,facilities,4,RESTRICTED,logistics,site;engineering,2026-03-01\n`, { existingTags: none, subject: operator });
    expect(plan.problems).toEqual([]);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.input).toMatchObject({ tag: 'PUMP-1', criticality: 4, classification: 'RESTRICTED', owner: 'logistics', sharedWith: ['site', 'engineering'], commissionedAt: Date.parse('2026-03-01T00:00:00Z') });
  });

  it('reports the file as a whole when a column is unknown, required, or repeated', () => {
    expect(planAssetImport('tag,name,category,criticality,colour\nA-1,x,power,1,red\n', { existingTags: none, subject: operator }).problems).toEqual([{ row: 0, column: 'colour', message: 'unknown column' }]);
    expect(planAssetImport('tag,name,category\nA-1,x,power\n', { existingTags: none, subject: operator }).problems).toEqual([{ row: 0, column: 'criticality', message: 'required column is missing' }]);
    expect(planAssetImport('tag,tag,name,category,criticality\nA-1,A-2,x,power,1\n', { existingTags: none, subject: operator }).problems[0]).toMatchObject({ row: 0 });
  });

  it('lists every row problem by row and column, and imports none of the rows when any fails', () => {
    const plan = planAssetImport(`${HEAD}\nGOOD-1,ok,power,3,,,,\nbad tag,x,power,3,,,,\nNEW-2,x,power,9,,,,\nNEW-3,x,power\n`, { existingTags: none, subject: operator });
    expect(plan.problems.map((p) => [p.row, p.column])).toEqual([
      [2, 'tag'],
      [3, 'criticality'],
      [4, undefined],
    ]);
    expect(plan.problems[2]!.message).toMatch(/fields/);
    expect(plan.rows.map((r) => r.row)).toEqual([1]);
  });

  it('refuses a tag used twice in the file, or already in the register', () => {
    const dup = planAssetImport(`${HEAD}\nA-1,x,power,1,,,,\nA-1,y,power,1,,,,\n`, { existingTags: none, subject: operator });
    expect(dup.problems).toEqual([{ row: 2, column: 'tag', message: 'A-1 appears more than once in the file' }]);
    const taken = planAssetImport(`${HEAD}\nA-1,x,power,1,,,,\n`, { existingTags: new Set(['A-1']), subject: operator });
    expect(taken.problems).toEqual([{ row: 1, column: 'tag', message: 'tag A-1 is already in use' }]);
  });

  it('applies the clearance and organisation rule to each row', () => {
    const above = planAssetImport(`${HEAD}\nTOP-1,x,power,1,SECRET,,,\n`, { existingTags: none, subject: operator });
    expect(above.problems).toEqual([{ row: 1, column: 'classification', message: 'above your clearance' }]);
    const other = planAssetImport(`${HEAD}\nFOR-1,x,power,1,UNCLASSIFIED,engineering,,\n`, { existingTags: none, subject: operator });
    expect(other.problems).toEqual([{ row: 1, column: 'owner', message: 'only an administrator can import for another organisation' }]);
    const admin = planAssetImport(`${HEAD}\nFOR-1,x,power,1,UNCLASSIFIED,engineering,,\n`, { existingTags: none, subject: { ...operator, role: 'administrator' } });
    expect(admin.problems).toEqual([]);
  });

  it('reads stock columns for a supply item, and refuses a date it cannot read', () => {
    const ok = planAssetImport('tag,name,category,criticality,stock_quantity,reorder_level,stock_unit\nDSL-1,Diesel,supply,3,500,200,litres\n', { existingTags: none, subject: operator });
    expect(ok.rows[0]!.input.stock).toEqual({ quantity: 500, reorderLevel: 200, unit: 'litres' });
    const bad = planAssetImport(`${HEAD}\nA-1,x,power,1,,,,03/01/2026\n`, { existingTags: none, subject: operator });
    expect(bad.problems).toEqual([{ row: 1, column: 'commissioned_at', message: 'use a date (2026-10-18) or a time in milliseconds' }]);
  });

  it('refuses an empty file, a file that is too long, and a malformed quote', () => {
    expect(planAssetImport('', { existingTags: none, subject: operator }).problems).toEqual([{ row: 0, message: 'the file is empty' }]);
    const long = `tag,name,category,criticality\n${Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `T-${i},x,power,1`).join('\n')}\n`;
    expect(planAssetImport(long, { existingTags: none, subject: operator }).problems).toEqual([{ row: 0, message: `the file has more than ${MAX_IMPORT_ROWS} rows` }]);
    expect(planAssetImport('tag,name,category,criticality\n"A-1,x,power,1\n', { existingTags: none, subject: operator }).problems[0]).toMatchObject({ row: 0 });
  });
});
