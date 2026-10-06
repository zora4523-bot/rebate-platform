// Error responses of the HTTP entries (contracts/openapi.yaml ErrorEnvelope; contracts/error-codes.yaml
// 20001, 50001; every operation declares `4XX: ClientError` and `5XX: ServerError`). bootstrap.ts
// builds every HTTP entry on `PlatformFastifyAdapter` and registers `GlobalErrorFilter` as its only
// global exception filter, so every error raised while a request is handled ends here: Nest's
// (guards, pipes, interceptors, controllers, the 404 handler) and Fastify's (request body parsing,
// route schema validation, reply serialization: they reach Nest through the adapter's error handler).
//
// Classification, first match wins:
// - IdempotencyError 'outcome_unknown': no response at all, the connection is closed (BR-ID-10
//   细则「服务端的配合」: a lost COMMIT acknowledgement is not a definite business failure, and no
//   answer may make the client start another sensitive operation).
// - HttpException (the 20001 envelopes thrown by controllers, every business error, Nest's 404):
//   written back unchanged by Nest's BaseExceptionFilter; not logged.
// - RequestRejection (./request-checks.ts: a request check refusing a request before the body is
//   parsed, e.g. the risk module's 10401 / 10402 signature failures, BR-ID-09): its status (400–499)
//   and { code, msg, trace_id } without `data`; not logged. A status or code out of range falls
//   through to 50001 below.
// - Fastify route schema validation (FST_ERR_VALIDATION): HTTP 400 and 20001 naming the offending
//   fields (validationErrorEnvelope of ../validation/index.ts).
// - Fastify request body errors (a FastifyError coded FST_ERR_CTP_* with a 4xx status: malformed or
//   empty JSON, a body above the limit, a Content-Length mismatch, an unsupported Content-Type;
//   ./request-checks.ts raises the same FST_ERR_CTP_BODY_TOO_LARGE while buffering a body):
//   20001 with data.fields ['body'] and Fastify's status (400, 413, 415). 413 and 415 depart from
//   the HTTP 400 that error-codes.yaml gives 20001; contract task CT-01d declares them in its new
//   `http_also` field (20001: [413, 415]). Neither the request body nor Fastify's message is
//   written back or logged.
// - Anything else (any other Error, also one carrying statusCode / status / expose, a thrown string,
//   object or null, other IdempotencyErrors, Fastify server errors, a reply that cannot be
//   serialized): one pino `error` line 'unhandled_error' with trace_id, error_class and stack (never
//   the request body or other properties of the thrown value), then HTTP 500
//   { code: 50001, msg, trace_id }. If the response was already sent, only the log line is written.
//
// Known exceptions: any other Fastify 4xx error goes through `super.mapException` and becomes an
// HttpException written back as Nest's { statusCode, message }; with the current code none is raised
// while a request is handled, so recheck this when adding a Fastify plugin (rate limiting,
// multipart, ...). If `handlerTimeout` is ever configured, FST_ERR_HANDLER_TIMEOUT (503) lands on
// 500 / 50001, not 50301.
//
// Not imported by ./index.ts: this file uses NestJS, and the `test` project compiles only what the
// rule tests import (./index.ts).
import { Catch, HttpException, type ArgumentsHost, type HttpServer } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { IdempotencyError } from '../idempotency/index.ts';
import type { RootLogger } from '../logging/index.ts';
import { fieldsErrorEnvelope, validationErrorEnvelope } from '../validation/index.ts';
import { RequestRejection } from './request-checks.ts';

/** The contract ErrorEnvelope as this filter writes it. */
export interface ErrorEnvelopeBody {
  readonly code: number;
  readonly msg: string;
  readonly data?: { readonly fields: readonly string[] };
  readonly trace_id: string;
}

export interface ErrorResponse {
  readonly statusCode: number;
  readonly body: ErrorEnvelopeBody;
}

export interface ServerErrorResponse extends ErrorResponse {
  readonly statusCode: 500;
  readonly body: { readonly code: 50001; readonly msg: string; readonly trace_id: string };
}

/** HTTP 500 and the 50001 envelope; `msg` is the meaning of 50001 in contracts/error-codes.yaml. */
export function serverErrorEnvelope(traceId: string): ServerErrorResponse {
  return { statusCode: 500, body: { code: 50001, msg: '服务端错误', trace_id: traceId } };
}

interface FastifyErrorShape extends Error {
  readonly code: string;
  readonly statusCode: number;
}

/** An error created by Fastify (@fastify/error): name FastifyError, a string code, a status. */
function asFastifyError(error: unknown): FastifyErrorShape | undefined {
  if (!(error instanceof Error) || error.name !== 'FastifyError') return undefined;
  const { code, statusCode } = error as Partial<FastifyErrorShape>;
  return typeof code === 'string' && typeof statusCode === 'number'
    ? (error as FastifyErrorShape)
    : undefined;
}

/** Fastify's request body errors: FST_ERR_CTP_* with a client status (400, 413, 415). */
export function isRequestBodyError(error: unknown): boolean {
  const fastify = asFastifyError(error);
  return (
    fastify !== undefined &&
    fastify.code.startsWith('FST_ERR_CTP_') &&
    fastify.statusCode >= 400 &&
    fastify.statusCode <= 499
  );
}

/**
 * 20001 with data.fields ['body'] and Fastify's status for a request body error; undefined for any
 * other value.
 */
export function requestBodyErrorEnvelope(
  error: unknown,
  traceId: string,
): ErrorResponse | undefined {
  if (!isRequestBodyError(error)) return undefined;
  return {
    statusCode: (error as FastifyErrorShape).statusCode,
    body: fieldsErrorEnvelope(['body'], traceId).body,
  };
}

/**
 * The status and the envelope { code, msg, trace_id } of a RequestRejection with a client status
 * (400–499) and a contract code (10000–99999); undefined for any other value.
 */
export function requestRejectionEnvelope(
  error: unknown,
  traceId: string,
): ErrorResponse | undefined {
  if (!(error instanceof RequestRejection)) return undefined;
  const { code, statusCode, message } = error;
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 499) return undefined;
  if (!Number.isInteger(code) || code < 10000 || code > 99999) return undefined;
  return { statusCode, body: { code, msg: message, trace_id: traceId } };
}

/** Constructor name of an Error, 'null' for null, typeof for any other value. */
export function errorClass(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return error === null ? 'null' : typeof error;
}

/**
 * The Fastify adapter of the HTTP entries. Nest's FastifyAdapter turns every Fastify error carrying a
 * status into `HttpException(message, status)` before any filter sees it: the Fastify code would be
 * lost and the message written back as `{ statusCode, message }`. This adapter keeps request body
 * errors (FST_ERR_CTP_*, 4xx) and Fastify errors with a status of 500 or above as they are, so that
 * `GlobalErrorFilter` answers them with the contract envelope; any other Fastify error is mapped as
 * Nest does.
 */
export class PlatformFastifyAdapter extends FastifyAdapter {
  override mapException(error: unknown): unknown {
    const fastify = asFastifyError(error);
    if (fastify === undefined || isRequestBodyError(fastify) || fastify.statusCode >= 500) {
      return error;
    }
    return super.mapException(error);
  }
}

interface Reply {
  hijack(): void;
  readonly raw: { destroy(): void };
}

@Catch()
export class GlobalErrorFilter extends BaseExceptionFilter<unknown> {
  readonly #adapter: HttpServer;
  readonly #logger: RootLogger;

  constructor(adapter: HttpServer, logger: RootLogger) {
    super(adapter);
    this.#adapter = adapter;
    this.#logger = logger;
  }

  override catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    if (error instanceof IdempotencyError && error.code === 'outcome_unknown') {
      const reply = http.getResponse<Reply>();
      reply.hijack();
      reply.raw.destroy();
      return;
    }
    if (error instanceof HttpException) {
      super.catch(error, host);
      return;
    }
    const traceId = http.getRequest<{ id: string }>().id;
    const response =
      requestRejectionEnvelope(error, traceId) ??
      validationErrorEnvelope(error, traceId) ??
      requestBodyErrorEnvelope(error, traceId) ??
      this.#unhandled(error, traceId);
    const reply = http.getResponse<unknown>();
    if (this.#adapter.isHeadersSent(reply)) {
      this.#adapter.end(reply);
      return;
    }
    this.#adapter.reply(reply, response.body, response.statusCode);
  }

  #unhandled(error: unknown, traceId: string): ServerErrorResponse {
    this.#logger.error(
      {
        trace_id: traceId,
        error_class: errorClass(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'unhandled_error',
    );
    return serverErrorEnvelope(traceId);
  }
}
