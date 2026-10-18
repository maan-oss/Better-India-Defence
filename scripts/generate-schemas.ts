// Writes the JSON Schema documents for the integration contracts into docs/schemas. Run with `npm run schemas`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractDocuments } from '../packages/domain/src/schemas/contracts.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'schemas');
mkdirSync(out, { recursive: true });
for (const [name, doc] of Object.entries(contractDocuments())) {
  writeFileSync(join(out, `${name}.schema.json`), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote docs/schemas/${name}.schema.json`);
}
