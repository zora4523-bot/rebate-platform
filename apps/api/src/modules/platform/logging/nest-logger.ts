// Adapter that routes NestJS framework logs into the pino root logger.
import type { LoggerService } from '@nestjs/common';
import type { RootLogger } from './logger.ts';
import { attempt, redactText, redactValue, stringifyValue } from './redaction.ts';

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export class PinoNestLogger implements LoggerService {
  private readonly logger: RootLogger;

  constructor(logger: RootLogger) {
    this.logger = logger;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  // Nest passes the context name as the last string parameter; `error` and `fatal` may put a
  // stack trace before it.
  private write(level: Level, message: unknown, optionalParams: unknown[]): void {
    const params = [...optionalParams];
    const last = params[params.length - 1];
    const context = typeof last === 'string' ? (params.pop() as string) : undefined;
    const fields: Record<string, unknown> = {};
    if (context !== undefined) fields['context'] = redactText(context);
    if (message instanceof Error) {
      fields['err'] = message;
    }
    if ((level === 'error' || level === 'fatal') && typeof params[0] === 'string') {
      fields['stack'] = params.shift();
    }
    if (params.length > 0) {
      fields['params'] = params.map((param) =>
        typeof param === 'string' ? redactText(param) : redactValue(param),
      );
    }
    const text =
      message instanceof Error
        ? String(attempt(() => message.message))
        : typeof message === 'string'
          ? message
          : stringifyValue(redactValue(message));
    this.logger[level](fields, text);
  }
}
