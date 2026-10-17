import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { SCENARIO_KEYS } from './truth/scenarios.ts';

const stateSchema = z.object({
  version: z.literal(1),
  recordingStart: z.number().nullable(),
  recordingEnd: z.number().nullable(),
  schedule: z.array(z.object({ id: z.string(), key: z.enum(SCENARIO_KEYS), t0: z.number(), source: z.enum(['recording', 'operator']) })),
});
export type SimState = z.infer<typeof stateSchema>;

export function loadState(path: string): SimState {
  if (!existsSync(path)) return { version: 1, recordingStart: null, recordingEnd: null, schedule: [] };
  return stateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveState(path: string, s: SimState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2));
}

