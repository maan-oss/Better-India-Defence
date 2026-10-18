import { z } from 'zod';
import { AssetInput, ReorderDecisionInput, ReorderInput, StockChangeInput } from './assets.ts';
import { ingestEnvelopeSchema } from './ingest.ts';

/**
 * The request and message contracts that other systems integrate with, as JSON Schema documents generated from the same
 * zod schemas the server enforces. `docs/schemas/*.schema.json` is written from these by `npm run schemas`; a test fails
 * when the committed files drift from the code.
 */
export const CONTRACTS = {
  'ingest-envelope': ingestEnvelopeSchema,
  'asset-input': AssetInput,
  'stock-change': StockChangeInput,
  'reorder-request': ReorderInput,
  'reorder-decision': ReorderDecisionInput,
} as const;

export type ContractName = keyof typeof CONTRACTS;

export function contractDocuments(): Record<ContractName, Record<string, unknown>> {
  return Object.fromEntries(
    (Object.keys(CONTRACTS) as ContractName[]).map((name) => [
      name,
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: `https://strata.local/schemas/${name}.schema.json`,
        title: name,
        ...z.toJSONSchema(CONTRACTS[name], { target: 'draft-2020-12', io: 'input' }),
      },
    ]),
  ) as unknown as Record<ContractName, Record<string, unknown>>;
}
