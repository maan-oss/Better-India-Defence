import { z } from 'zod';
import { resolve } from 'node:path';

/** All configuration comes from the environment (12-factor). Secrets are never hard-coded for production. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /**
   * operational (default): real site, real sensors, no synthetic data — the first run opens the setup wizard.
   * demo: the synthetic KESTREL facility with the scenario simulator, demo accounts and sample content
   * (evaluation and automated tests only). Tests default to demo.
   */
  STRATA_MODE: z.enum(['operational', 'demo']).optional(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default('data'),
  STRATA_SERVICE_TOKEN: z.string().min(16).default('dev-service-token-change-me'),
  SIM_URL: z.string().url().default('http://127.0.0.1:4100'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  STRATA_DEMO_USERS: z.enum(['true', 'false']).optional(),
  STRATA_DEMO_PASSWORD: z.string().min(8).default('strata-demo'),
  STRATA_ADMIN_PASSWORD: z.string().min(12).optional(),
  STORAGE_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 32 bytes hex')
    .optional(),
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  /** Set when TLS is terminated by a reverse proxy in front of this process. */
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  ANTHROPIC_API_KEY: z.string().optional(),
  COPILOT_MODEL: z.string().default('claude-opus-5-5'),
  COPILOT_PROVIDER: z.enum(['auto', 'deterministic', 'anthropic']).default('auto'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WEB_DIST: z.string().optional(),
  AUTO_INCIDENTS: z.enum(['true', 'false']).default('true'),
  /** Directory from which file-based camera sources (recorded feeds) may be read. */
  STRATA_IMPORT_DIR: z.string().optional(),
  /** Seed demonstration identities, evidence and a demo camera on the demo site (default: on, except in tests). */
  STRATA_DEMO_CONTENT: z.enum(['true', 'false']).optional(),
  STRATA_MODELS_DIR: z.string().optional(),
});

export type Config = Omit<z.infer<typeof schema>, 'STRATA_MODE' | 'STRATA_DEMO_USERS'> & {
  dataDir: string;
  STRATA_MODE: 'operational' | 'demo';
  STRATA_DEMO_USERS: 'true' | 'false';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const raw = parsed.data;
  const mode = raw.STRATA_MODE ?? (raw.NODE_ENV === 'test' ? 'demo' : 'operational');
  const c = { ...raw, STRATA_MODE: mode, STRATA_DEMO_USERS: raw.STRATA_DEMO_USERS ?? (mode === 'demo' ? 'true' : 'false') } as const;
  if (mode === 'demo' && c.NODE_ENV === 'production') throw new Error('STRATA_MODE=demo is not allowed with NODE_ENV=production');
  if (c.NODE_ENV === 'production') {
    if (c.STRATA_SERVICE_TOKEN === 'dev-service-token-change-me') throw new Error('STRATA_SERVICE_TOKEN must be set in production');
    if (c.STRATA_DEMO_USERS === 'true') throw new Error('Demo users must be disabled in production (STRATA_DEMO_USERS=false)');
  }
  return { ...c, dataDir: resolve(c.DATA_DIR) };
}
