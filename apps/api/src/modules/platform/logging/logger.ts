// Root logger (ADR-0001 §2 日志与监控): pino, JSON lines on stdout. Application code logs only
// through this logger or children of it; `console` is not used.
import {
  pino,
  type ChildLoggerOptions,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';
import type { LogLevel } from '../config/index.ts';
import {
  REDACTED,
  SENSITIVE_KEYS,
  attempt,
  redactMessage,
  redactPath,
  redactRecord,
  redactValue,
  stringifyValue,
  type FieldSerializers,
} from './redaction.ts';

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

/** Fastify Request getters must be read before copying; plain req records retain their shape. */
function serializeRequest(value: unknown): unknown {
  return attempt(() => {
    if (value === null || typeof value !== 'object' || !('raw' in value) || !('ip' in value)) {
      return redactValue(value);
    }
    const request = value as {
      method?: unknown;
      routeOptions?: { url?: unknown };
      hostname?: unknown;
      ip: unknown;
      socket?: { remotePort?: unknown };
    };
    const url = request.routeOptions?.url;
    return redactRecord({
      method: request.method,
      url: typeof url === 'string' ? redactPath(url) : '[unmatched]',
      hostname: request.hostname,
      remoteAddress: request.ip,
      remotePort: request.socket?.remotePort,
    });
  });
}

/** `destination` defaults to stdout; tests pass an in-memory stream. */
export function createRootLogger(
  options: RootLoggerOptions,
  destination?: DestinationStream,
): RootLogger {
  const configurations = new WeakMap<object, FieldSerializers>();
  const formatters = new WeakMap<
    object,
    { [Key in 'log' | 'bindings']: NonNullable<ChildLoggerOptions['formatters']>[Key] }
  >();
  // msg is always serialized by pino after printf expansion and msgPrefix. Other serializers
  // run once, on the original field values, in the hook/bindings formatter before redaction.
  const withoutMessage = (serializers: FieldSerializers): FieldSerializers =>
    Object.fromEntries(Object.entries(serializers).filter(([key]) => key !== 'msg'));
  const finalSerializers = (serializers: FieldSerializers) => ({
    err: (value: unknown) => value,
    msg: (value: unknown) =>
      redactMessage(serializers['msg'] ? attempt(() => serializers['msg']!(value)) : value),
  });
  const loggerOptions: LoggerOptions = {
    level: options.level,
    base: { entry: options.entry, env: options.appEnv, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Pino's bigint fallback must not impose its default five-level/100-field truncation.
    depthLimit: 110,
    edgeLimit: Number.MAX_SAFE_INTEGER,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    serializers: { ...finalSerializers({}), req: serializeRequest },
    formatters: { log: redactRecord, bindings: redactRecord },
    hooks: {
      logMethod(args, method) {
        const first = args[0];
        const hasFields = typeof first === 'object' && first !== null;
        const messageIndex = hasFields || first === null || first === undefined ? 1 : 0;
        const safeArgs: unknown[] = [...args];
        if (hasFields) {
          safeArgs[0] = redactRecord(
            first instanceof Error ? { err: first } : first,
            withoutMessage(configurations.get(this) ?? {}),
          );
        }
        const message = args[messageIndex];
        if (message !== undefined && typeof message !== 'string') {
          safeArgs[messageIndex] = redactMessage(message);
        }
        for (let index = messageIndex + 1; index < args.length; index++) {
          safeArgs[index] = redactValue(args[index]);
        }
        // Only Error gets human-readable %s text. Other objects use the safe JSON copy,
        // never caller toString methods. Every %<character> except %% consumes an argument.
        if (typeof message === 'string') {
          let index = messageIndex + 1;
          for (const match of message.matchAll(/%[\s\S]/g)) {
            if (match[0] === '%%') continue;
            if (index >= args.length) break;
            const original = args[index];
            if (match[0] === '%s') {
              safeArgs[index] = attempt(() => {
                if (original instanceof Error) return `${original.name}: ${original.message}`;
                const copy = safeArgs[index];
                if (copy !== null && typeof copy === 'object') return stringifyValue(copy) ?? '';
                return String(copy);
              });
            }
            index++;
          }
        }
        method.apply(this, safeArgs as Parameters<typeof method>);
      },
    },
  };
  const logger = destination === undefined ? pino(loggerOptions) : pino(loggerOptions, destination);
  configurations.set(logger, { req: serializeRequest });
  // Children inherit this wrapper; closures for binding formatters also cover setBindings().
  const child = logger.child;
  logger.child = function (this: RootLogger, bindings, options) {
    const serializers = { ...configurations.get(this), ...options?.serializers };
    const bindingFormatter = options?.formatters?.bindings ?? formatters.get(this)?.bindings;
    const logFormatter = options?.formatters?.log ?? formatters.get(this)?.log;
    const result = child.call(this, bindings, {
      ...options,
      serializers: finalSerializers(serializers),
      formatters: {
        ...options?.formatters,
        bindings: (value) =>
          redactRecord(
            bindingFormatter ? bindingFormatter(value) : value,
            withoutMessage(serializers),
          ),
        log: (value) => redactRecord(logFormatter ? logFormatter(value) : value),
      },
    });
    configurations.set(result, serializers);
    formatters.set(result, { bindings: bindingFormatter, log: logFormatter });
    return result;
  } as typeof logger.child;
  return logger;
}
