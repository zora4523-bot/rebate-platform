// Root logger (ADR-0001 §2 日志与监控): pino, JSON lines on stdout. Application code logs only
// through this logger or children of it; `console` is not used.
import { pino, type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from '../config/index.ts';

export type RootLogger = Logger;

const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'step_up_token',
  'secret',
  'phone',
  'id_no',
] as const;

/**
 * pino `redact` paths: sensitive keys at the top level and one level down, plus the HTTP
 * header locations used by request / response serializers. Log flat objects: deeper nesting
 * is not covered, and whole request or user objects must not be logged (规划/02 §19).
 */
export const REDACT_PATHS: readonly string[] = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-step-up-token"]',
  'req.headers["x-sign"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
];

export const REDACTED = '[REDACTED]';

export interface RootLoggerOptions {
  readonly level: LogLevel;
  /** Process entry name, bound to every line. */
  readonly entry: string;
  /** APP_ENV, bound to every line. */
  readonly appEnv: string;
}

/** `destination` defaults to stdout; tests pass an in-memory stream. */
export function createRootLogger(
  options: RootLoggerOptions,
  destination?: DestinationStream,
): RootLogger {
  const loggerOptions = {
    level: options.level,
    base: { entry: options.entry, env: options.appEnv, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
  };
  return destination === undefined ? pino(loggerOptions) : pino(loggerOptions, destination);
}
