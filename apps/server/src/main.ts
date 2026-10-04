import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { Platform } from './platform.ts';
import { buildApp } from './app.ts';

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL, cfg.NODE_ENV !== 'production');
const platform = new Platform(cfg, log);

try {
  await platform.start();
  const app = await buildApp(platform);
  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  log.info({ url: `${cfg.TLS_CERT_FILE ? 'https' : 'http'}://${cfg.HOST}:${cfg.PORT}` }, 'Strata API listening');
  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    await app.close();
    await platform.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
} catch (e) {
  log.fatal({ err: e instanceof Error ? e.stack : String(e) }, 'failed to start');
  await platform.stop().catch(() => undefined);
  process.exit(1);
}
