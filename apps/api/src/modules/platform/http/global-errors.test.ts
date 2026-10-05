import { fileURLToPath } from 'node:url';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Res,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AppModule } from '../../../app.module.ts';
import { createHttpApp } from '../../../bootstrap.ts';
import { IdempotencyError } from '../idempotency/index.ts';
import { FixedClock, createRootLogger, loadConfig } from '../index.ts';
import { createValidatorCompiler } from '../validation/index.ts';
import { PlatformFastifyAdapter } from './global-errors.ts';

const TRACE = 'abcdefABCDEF01234567abcdefABCDEF';
const BODY_MARKER = 'body-marker-q7';
const VALUE_MARKER = 'thrown-value-marker-q7';

function thrown(kind: string): unknown {
  switch (kind) {
    case 'type-error':
      return new TypeError('crash detail');
    case 'text':
      return VALUE_MARKER;
    case 'null':
      return null;
    case 'status':
      return Object.assign(new Error('status detail'), {
        statusCode: 418,
        status: 418,
        expose: true,
        detail: VALUE_MARKER,
      });
    case 'internal':
      return new IdempotencyError('invalid_result');
    case 'uncertain':
      return new IdempotencyError('outcome_unknown');
    case 'ordinary':
      return new BadRequestException('ordinary HTTP error');
    default:
      return new HttpException(
        { code: 20001, msg: 'x', data: { fields: ['a'] }, trace_id: 't' },
        400,
      );
  }
}

class FailingGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    throw thrown(context.switchToHttp().getRequest<{ params: { kind: string } }>().params.kind);
  }
}

@Controller('__global_errors')
class ProbeController {
  @Post('controller/:kind')
  controller(@Param('kind') kind: string, @Body() body: unknown) {
    void body;
    throw thrown(kind);
  }

  @Post('guard/:kind')
  @UseGuards(FailingGuard)
  guarded() {
    return { guardWasBypassed: true };
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    return { body };
  }

  @Get('bigint')
  bigint() {
    return { cannotSerialize: 1n };
  }

  @Get('sent-then-throw')
  sentThenThrow(@Res() reply: { send(payload: unknown): unknown }) {
    reply.send({ first: 'already sent' });
    throw new TypeError('after send');
  }
}

let validate: ReturnType<ReturnType<typeof createValidatorCompiler>>;
let app: NestFastifyApplication;
let lines: string[];

beforeAll(async () => {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  validate = createValidatorCompiler()({
    schema: document.components?.schemas?.['ErrorEnvelope'] as object as Record<string, unknown>,
    httpPart: 'body',
  });
});

beforeEach(async () => {
  lines = [];
  const original = AppModule.forEntry;
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => ({
    ...original(options),
    controllers: [ProbeController],
  }));
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-06T04:00:00Z'),
    logger: createRootLogger(
      { level: 'info', entry: 'api', appEnv: 'test' },
      { write: (chunk: string) => void lines.push(chunk) },
    ),
  });
  await app.init();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

function unhandled(): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record['msg'] === 'unhandled_error');
}

function post(url: string, payload: string, contentType = 'application/json') {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'x-trace-id': TRACE, 'content-type': contentType },
    payload,
  });
}

function expectServerError(response: { statusCode: number; body: string }): void {
  expect(response.statusCode).toBe(500);
  expect(JSON.parse(response.body)).toEqual({ code: 50001, msg: '服务端错误', trace_id: TRACE });
  expect(validate(JSON.parse(response.body))).toBe(true);
}

it('[AC-B1-01za#5] an unknown controller error answers 500 / 50001 and logs trace id, class and stack only', async () => {
  const response = await post(
    '/__global_errors/controller/type-error',
    `{"note":"${BODY_MARKER}"}`,
  );
  expectServerError(response);
  expect(response.headers['x-trace-id']).toBe(TRACE);
  const records = unhandled();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ level: 50, trace_id: TRACE, error_class: 'TypeError' });
  expect(records[0]!['stack']).toMatch(/^TypeError: crash detail\n/);
  expect(lines.join('')).not.toContain(BODY_MARKER);
});

it('[AC-B1-01za#8] thrown non-errors, errors carrying a status and internal platform errors get the same envelope', async () => {
  for (const [kind, errorClass] of [
    ['text', 'string'],
    ['null', 'null'],
    ['status', 'Error'],
    ['internal', 'IdempotencyError'],
  ] as const) {
    lines.length = 0;
    const response = await post(`/__global_errors/controller/${kind}`, '{}');
    expectServerError(response);
    expect(unhandled()).toMatchObject([{ trace_id: TRACE, error_class: errorClass }]);
    expect(response.body + lines.join('')).not.toContain(VALUE_MARKER);
  }
});

it('[AC-B1-01za#4] errors thrown in a guard are classified like controller errors', async () => {
  const unknown = await post('/__global_errors/guard/type-error', '{}');
  expectServerError(unknown);
  expect(unhandled()).toMatchObject([{ trace_id: TRACE, error_class: 'TypeError' }]);
  lines.length = 0;
  const business = await post('/__global_errors/guard/envelope', '{}');
  expect(business.statusCode).toBe(400);
  expect(business.json()).toEqual({
    code: 20001,
    msg: 'x',
    data: { fields: ['a'] },
    trace_id: 't',
  });
  expect(unhandled()).toEqual([]);
  await expect(post('/__global_errors/guard/uncertain', '{}')).rejects.toMatchObject({
    code: 'LIGHT_ECONNRESET',
  });
  await expect(post('/__global_errors/controller/uncertain', '{}')).rejects.toMatchObject({
    code: 'LIGHT_ECONNRESET',
  });
});

it('[AC-B1-01za#7] HttpExceptions are written back unchanged and not logged as unhandled', async () => {
  const ordinary = await post('/__global_errors/controller/ordinary', '{}');
  expect(ordinary.statusCode).toBe(400);
  expect(ordinary.json()).toMatchObject({ message: 'ordinary HTTP error' });
  const envelope = await post('/__global_errors/controller/envelope', '{}');
  expect(envelope.statusCode).toBe(400);
  expect(envelope.json()).toEqual({
    code: 20001,
    msg: 'x',
    data: { fields: ['a'] },
    trace_id: 't',
  });
  expect((await app.inject({ url: '/missing' })).statusCode).toBe(404);
  expect(unhandled()).toEqual([]);
});

it('[AC-B1-01za#1][AC-B1-01za#2][AC-B1-01za#3] request body errors answer 20001 with fields [body], keep the Fastify status and echo nothing', async () => {
  const cases: [string, string, string, number][] = [
    ['malformed JSON', `{"note":"${BODY_MARKER}",}`, 'application/json', 400],
    ['malformed JSON text', `${BODY_MARKER}{`, 'application/json', 400],
    ['empty JSON', '', 'application/json', 400],
    ['unsupported media type', BODY_MARKER, 'application/x-global-errors', 415],
    ['body above the limit', `"${BODY_MARKER}${'x'.repeat(1024 * 1024)}"`, 'application/json', 413],
  ];
  for (const [label, payload, contentType, statusCode] of cases) {
    lines.length = 0;
    const response = await post('/__global_errors/echo', payload, contentType);
    expect({ label, statusCode: response.statusCode }).toEqual({ label, statusCode });
    expect({ label, body: response.json() }).toEqual({
      label,
      body: { code: 20001, msg: '参数校验失败', data: { fields: ['body'] }, trace_id: TRACE },
    });
    expect(validate(response.json())).toBe(true);
    expect(response.headers['x-trace-id']).toBe(TRACE);
    expect(response.body + lines.join('')).not.toContain(BODY_MARKER);
    expect(unhandled()).toEqual([]);
  }
  const accepted = await post('/__global_errors/echo', '{"ok":true}');
  expect(accepted.json()).toEqual({ body: { ok: true } });
});

it('[AC-B1-01za#6] a reply that cannot be serialized answers 500 / 50001 and the app keeps serving', async () => {
  const response = await app.inject({
    url: '/__global_errors/bigint',
    headers: { 'x-trace-id': TRACE },
  });
  expectServerError(response);
  expect(unhandled()).toMatchObject([{ trace_id: TRACE, error_class: 'TypeError' }]);
  const next = await post('/__global_errors/echo', '{"ok":true}');
  expect(next.statusCode).toBe(201);
});

it('[AC-B1-01za#5] an unknown error after the response was sent keeps that response, logs once and the app keeps serving', async () => {
  const crashes: unknown[] = [];
  const record = (error: unknown) => void crashes.push(error);
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  try {
    const response = await app.inject({
      url: '/__global_errors/sent-then-throw',
      headers: { 'x-trace-id': TRACE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ first: 'already sent' });
    const records = unhandled();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 50, trace_id: TRACE, error_class: 'TypeError' });
    expect(records[0]!['stack']).toMatch(/^TypeError: after send\n/);
    const warnings = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => (entry['level'] as number) >= 40);
    expect(warnings).toEqual(records);
    const next = await post('/__global_errors/echo', '{"ok":true}');
    expect(next.statusCode).toBe(201);
    expect(next.json()).toEqual({ body: { ok: true } });
    expect(crashes).toEqual([]);
  } finally {
    process.off('uncaughtException', record);
    process.off('unhandledRejection', record);
  }
});

it('[AC-B1-01za#1] the adapter keeps request body errors and Fastify server errors for the filter', async () => {
  const adapter = new PlatformFastifyAdapter();
  const fastifyError = (code: string, statusCode: number): Error => {
    const error = Object.assign(new Error(`${code} message`), { code, statusCode });
    error.name = 'FastifyError';
    return error;
  };
  try {
    for (const kept of [
      fastifyError('FST_ERR_CTP_INVALID_MEDIA_TYPE', 415),
      fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413),
      fastifyError('FST_ERR_CTP_EMPTY_JSON_BODY', 400),
      fastifyError('FST_ERR_CTP_INVALID_TYPE', 500),
      fastifyError('FST_ERR_FAILED_ERROR_SERIALIZATION', 500),
      Object.assign(new Error('not a Fastify error'), { code: 'FST_ERR_CTP_X', statusCode: 400 }),
      null,
      'text',
    ]) {
      expect(adapter.mapException(kept)).toBe(kept);
    }
    const mapped = adapter.mapException(fastifyError('FST_ERR_OTHER_CLIENT', 404));
    expect(mapped).toBeInstanceOf(HttpException);
    expect((mapped as HttpException).getStatus()).toBe(404);
  } finally {
    await adapter.close();
  }
});
