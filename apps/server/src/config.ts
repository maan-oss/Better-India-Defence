import { z } from 'zod';
import { resolve } from 'node:path';

/** All configuration comes from the environment (12-factor). Secrets are never hard-coded for production. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default('data'),
  STRATA_SERVICE_TOKEN: z.string().min(16).default('dev-service-token-change-me'),
  SIM_URL: z.string().url().default('http://127.0.0.1:4100'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  STRATA_DEMO_USERS: z.enum(['true', 'false']).default('true'),
  STRATA_DEMO_PASSWORD: z.string().min(8).default('strata-demo'),
  STRATA_ADMIN_PASSWORD: z.string().min(12).optional(),
  STORAGE_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 32 bytes hex')
    .optional(),
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  COPILOT_MODEL: z.string().default('claude-opus-5-5'),
  COPILOT_PROVIDER: z.enum(['auto', 'deterministic', 'anthropic']).default('auto'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WEB_DIST: z.string().optional(),
  AUTO_INCIDENTS: z.enum(['true', 'false']).default('true'),
});

export type Config = z.infer<typeof schema> & { dataDir: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    if (c.STRATA_SERVICE_TOKEN === 'dev-service-token-change-me') throw new Error('STRATA_SERVICE_TOKEN must be set in production');
    if (c.STRATA_DEMO_USERS === 'true') throw new Error('Demo users must be disabled in production (STRATA_DEMO_USERS=false)');
    if (!c.STRATA_ADMIN_PASSWORD) throw new Error('STRATA_ADMIN_PASSWORD must be set in production');
  }
  return { ...c, dataDir: resolve(c.DATA_DIR) };
}
