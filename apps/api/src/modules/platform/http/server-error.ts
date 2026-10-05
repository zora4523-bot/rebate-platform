// Unhandled errors of HTTP handlers (contracts/error-codes.yaml 50001; every /v1 operation declares
// `5XX: ServerError`, whose body is the ErrorEnvelope). Registered globally by PlatformModule as
// APP_INTERCEPTOR, so it applies to every entry.
//
// Why an interceptor and not an APP_FILTER: bootstrap.ts appends its catch-all global filter
// (RequestValidationFilter) after NestFactory.create, and Nest consults the global filters in the
// reverse order of registration and uses the first that matches, so an APP_FILTER would never be
// reached. This interceptor turns an unknown error into an HttpException carrying the envelope;
// that filter then writes HttpExceptions back unchanged.
//
// - HttpException (the 20001 envelopes, every other business error): rethrown unchanged.
// - IdempotencyError 'outcome_unknown': rethrown unchanged; the global filter closes the
//   connection instead of answering (BR-ID-10 细则「服务端的配合」).
// - Anything else: one pino `error` line with the error class, its stack and the trace id (never
//   the request body), then HTTP 500 { code: 50001, msg, trace_id } with the request's trace id.
//
// Not imported by ./index.ts: this file uses NestJS, and the `test` project compiles only what the
// rule tests import (./index.ts).
import {
  HttpException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, type Observable } from 'rxjs';
import { IdempotencyError } from '../idempotency/index.ts';
import type { RootLogger } from '../logging/index.ts';

export interface ServerErrorResponse {
  readonly statusCode: 500;
  readonly body: { readonly code: 50001; readonly msg: string; readonly trace_id: string };
}

/** HTTP 500 and the 50001 envelope; `msg` is the meaning of 50001 in contracts/error-codes.yaml. */
export function serverErrorEnvelope(traceId: string): ServerErrorResponse {
  return { statusCode: 500, body: { code: 50001, msg: '服务端错误', trace_id: traceId } };
}

function passesThrough(error: unknown): boolean {
  return (
    error instanceof HttpException ||
    (error instanceof IdempotencyError && error.code === 'outcome_unknown')
  );
}

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return error === null ? 'null' : typeof error;
}

export class ServerErrorInterceptor implements NestInterceptor {
  readonly #logger: RootLogger;

  constructor(logger: RootLogger) {
    this.#logger = logger;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (passesThrough(error) || context.getType() !== 'http') throw error;
        const traceId = context.switchToHttp().getRequest<{ id: string }>().id;
        this.#logger.error(
          {
            trace_id: traceId,
            error_class: errorClass(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'unhandled_error',
        );
        const { statusCode, body } = serverErrorEnvelope(traceId);
        throw new HttpException(body, statusCode);
      }),
    );
  }
}
