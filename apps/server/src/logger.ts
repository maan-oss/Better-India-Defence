import pino from 'pino';

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    base: { service: 'strata-server' },
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'password', '*.password'], remove: true },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } } } : {}),
  });
}
export type Logger = ReturnType<typeof createLogger>;
