// Root logger (ADR-0001 §2 日志与监控): pino, JSON lines on stdout. Application code logs only
// through this logger or children of it; `console` is not used.
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { LogLevel } from '../config/index.ts';
import { REDACTED, SENSITIVE_KEYS, redactRecord, redactText, redactValue } from './redaction.ts';

export { REDACTED, SENSITIVE_KEYS } from './redaction.ts';

export type RootLogger = Logger;

/**
 * Canonical pino paths retained for consumers. Runtime redaction also normalizes field names
 * and recursively visits every depth; these paths alone are not the complete protection.
 */
export const REDACT_PATHS: readonly string[] = Object.freeze([
  ...SENSITIVE_KEYS.map((key) => `[${JSON.stringify(key)}]`),
  ...SENSITIVE_KEYS.map((key) => `*[${JSON.stringify(key)}]`),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-step-up-token"]',
  'req.headers["x-sign"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
]);

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
  const loggerOptions: LoggerOptions = {
    level: options.level,
    base: { entry: options.entry, env: options.appEnv, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    // Pino invokes the msg serializer after printf formatting and child msgPrefix expansion.
    serializers: {
      err: (value: unknown) => redactValue(value),
      msg: (value: unknown) =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? redactText(String(value))
          : redactValue(value),
    },
    formatters: { log: redactRecord, bindings: redactRecord },
    hooks: {
      logMethod(args, method) {
        const safeArgs = args.map((value) => redactValue(value));
        // Preserve pino's direct Error shape and its message fallback after copying the Error.
        if (args[0] instanceof Error) safeArgs[0] = { err: safeArgs[0] };
        method.apply(this, safeArgs as Parameters<typeof method>);
      },
    },
  };
  const logger = destination === undefined ? pino(loggerOptions) : pino(loggerOptions, destination);
  // Pino resets the bindings formatter when creating children. Intercept its public entry
  // points so every generation and setBindings() is sanitized before bindings are serialized.
  const child = logger.child;
  logger.child = function (this: RootLogger, bindings, options) {
    return child.call(this, redactRecord(bindings), options);
  } as typeof logger.child;
  const setBindings = logger.setBindings;
  logger.setBindings = function (bindings) {
    setBindings.call(this, redactRecord(bindings));
  };
  return logger;
}
