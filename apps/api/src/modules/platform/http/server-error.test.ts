import { fileURLToPath } from 'node:url';
import { BadRequestException, Body, Controller, Get, HttpException, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppModule } from '../../../app.module.ts';
import { createHttpApp } from '../../../bootstrap.ts';
import { IdempotencyError } from '../idempotency/index.ts';
import { FixedClock, createRootLogger, loadConfig } from '../index.ts';
import { createValidatorCompiler } from '../validation/index.ts';

const TRACE = 'abcdefABCDEF01234567abcdefABCDEF';

@Controller('__server_error')
class ProbeController {
  @Post('crash')
  crash(@Body() body: unknown) {
    void body;
    throw new TypeError('crash detail');
  }

  @Get('thrown-text')
  thrownText() {
    throw 'plain text';
  }

  @Get('idempotency')
  idempotency() {
    throw new IdempotencyError('invalid_result');
  }

  @Get('ordinary')
  ordinary() {
    throw new BadRequestException('ordinary HTTP error');
  }

  @Get('envelope')
  envelope() {
    throw new HttpException({ code: 20001, msg: 'x', data: { fields: ['a'] }, trace_id: 't' }, 400);
  }
}

let app: NestFastifyApplication;
let lines: string[];

beforeEach(async () => {
  lines = [];
  const original = AppModule.forEntry;
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => ({
    ...original(options),
    controllers: [ProbeController],
  }));
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-05T04:00:00Z'),
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

it('[error-codes 50001] an unknown handler error answers 500 with the contract ErrorEnvelope and logs class and stack only', async () => {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const validate = createValidatorCompiler()({
    schema: document.components?.schemas?.['ErrorEnvelope'] as object as Record<string, unknown>,
    httpPart: 'body',
  });
  const response = await app.inject({
    method: 'POST',
    url: '/__server_error/crash',
    headers: { 'x-trace-id': TRACE },
    payload: { note: 'body-marker-q7' },
  });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ code: 50001, msg: '服务端错误', trace_id: TRACE });
  expect(validate(response.json())).toBe(true);
  const records = unhandled();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ level: 50, trace_id: TRACE, error_class: 'TypeError' });
  expect(records[0]!['stack']).toMatch(/^TypeError: crash detail\n/);
  expect(lines.join('')).not.toContain('body-marker-q7');
});

it('[error-codes 50001] thrown non-errors and internal platform errors get the same envelope', async () => {
  for (const [url, errorClass] of [
    ['/__server_error/thrown-text', 'string'],
    ['/__server_error/idempotency', 'IdempotencyError'],
  ] as const) {
    lines.length = 0;
    const response = await app.inject({ url, headers: { 'x-trace-id': TRACE } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 50001, msg: '服务端错误', trace_id: TRACE });
    expect(unhandled()).toMatchObject([{ error_class: errorClass }]);
  }
});

it('[error-codes 50001] HttpExceptions are written back unchanged and not logged as unhandled', async () => {
  const ordinary = await app.inject({ url: '/__server_error/ordinary' });
  expect(ordinary.statusCode).toBe(400);
  expect(ordinary.json()).toMatchObject({ message: 'ordinary HTTP error' });
  const envelope = await app.inject({ url: '/__server_error/envelope' });
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
