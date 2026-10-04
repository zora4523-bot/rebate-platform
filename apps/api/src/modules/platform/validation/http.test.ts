import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BadRequestException, Controller, Get, Post, Req } from '@nestjs/common';
import { RouteSchema, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppModule } from '../../../app.module.ts';
import { createHttpApp } from '../../../bootstrap.ts';
import { FixedClock, createRootLogger, loadConfig } from '../index.ts';
import { createValidatorCompiler, routeSchemaOf } from './index.ts';
import { healthSchemaFile, healthSchemaSource } from './scripts/generate-health-schema.ts';

const probeSchema = routeSchemaOf({
  operationId: 'validationProbe',
  parameters: [
    { in: 'path', name: 'id', schema: { type: 'integer', minimum: 1 } },
    { in: 'query', name: 'limit', required: true, schema: { type: 'integer', minimum: 1 } },
    { in: 'header', name: 'X-Count', required: true, schema: { type: 'integer', minimum: 1 } },
  ],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['amount'],
          properties: { amount: { type: 'integer', format: 'int64' } },
        },
      },
    },
  },
});

@Controller('__validation')
class ProbeController {
  @Post(':id')
  @RouteSchema(probeSchema)
  probe(
    @Req()
    request: {
      params: unknown;
      query: unknown;
      headers: Record<string, unknown>;
      body: unknown;
    },
  ) {
    return {
      params: request.params,
      query: request.query,
      count: request.headers['x-count'],
      body: request.body,
      retained: true,
    };
  }

  @Get('failure')
  failure() {
    throw new BadRequestException('ordinary HTTP error');
  }

  @Get('crash')
  crash() {
    throw new Error('internal detail');
  }
}

let app: NestFastifyApplication;
beforeEach(async () => {
  const original = AppModule.forEntry;
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => ({
    ...original(options),
    controllers: [ProbeController],
  }));
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-01T04:00:00Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

it('[AC-B1-01d#1] mounts the generated health schema and detects contract drift', async () => {
  expect(await readFile(healthSchemaFile, 'utf8')).toBe(await healthSchemaSource());
  const schemas: unknown[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url === '/healthz') schemas.push(route.schema);
    });
  await app.init();
  expect(schemas.length).toBeGreaterThan(0);
  expect(schemas.every((schema) => JSON.stringify(schema) === '{}')).toBe(true);
});

it('[AC-B1-01d#2] converts HTTP parameters, preserves body and response fields without listening', async () => {
  await app.init();
  const response = await app.inject({
    method: 'POST',
    url: '/__validation/2?limit=3',
    headers: { 'X-Count': '4', 'user-agent': 'probe' },
    payload: { amount: 99 },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json()).toEqual({
    params: { id: 2 },
    query: { limit: 3 },
    count: 4,
    body: { amount: 99 },
    retained: true,
  });
  expect(app.getHttpServer().listening).toBe(false);
});

it('[AC-B1-01d#3] maps real Fastify failures in all four parts to the contract error envelope', async () => {
  await app.init();
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const validate = createValidatorCompiler()({
    schema: document.components?.schemas?.['ErrorEnvelope'] as object as Record<string, unknown>,
    httpPart: 'body',
  });
  const cases = [
    {
      url: '/__validation/no?limit=3',
      payload: { amount: 99 },
      headers: { 'x-count': '4' },
      fields: ['id'],
    },
    {
      url: '/__validation/2?limit=bad',
      payload: { amount: 99 },
      headers: { 'x-count': '4' },
      fields: ['limit'],
    },
    {
      url: '/__validation/2?limit=3&unknown=1',
      payload: { amount: 99 },
      headers: { 'x-count': '4' },
      fields: ['unknown'],
    },
    {
      url: '/__validation/2?limit=3',
      payload: { amount: 99 },
      headers: { 'x-count': 'bad' },
      fields: ['x-count'],
    },
    {
      url: '/__validation/2?limit=3',
      payload: { amount: '99' },
      headers: { 'x-count': '4' },
      fields: ['amount'],
    },
    {
      url: '/__validation/2?limit=3',
      payload: { amount: 2 ** 53 },
      headers: { 'x-count': '4' },
      fields: ['amount'],
    },
    { url: '/__validation/2?limit=3', headers: { 'x-count': '4' }, fields: ['body'] },
  ];
  for (const { fields, ...request } of cases) {
    const response = await app.inject({
      ...request,
      method: 'POST',
      headers: { ...request.headers, 'x-trace-id': 'abcdefABCDEF01234567abcdefABCDEF' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 20001,
      msg: '参数校验失败',
      data: { fields },
      trace_id: 'abcdefABCDEF01234567abcdefABCDEF',
    });
    expect(validate(response.json())).toBe(true);
  }
});

it('[AC-B1-01d#4] delegates ordinary errors to the existing Nest handler', async () => {
  await app.init();
  const ordinary = await app.inject({ url: '/__validation/failure' });
  expect(ordinary.statusCode).toBe(400);
  expect(ordinary.json()).toMatchObject({ message: 'ordinary HTTP error' });
  const crash = await app.inject({ url: '/__validation/crash' });
  expect(crash.statusCode).toBe(500);
  expect(crash.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
  expect((await app.inject({ url: '/missing' })).statusCode).toBe(404);
});

it('[AC-B1-01d#5] rejects an invalid route schema when Fastify prepares the application', async () => {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url === '/__validation/:id')
        route.schema = { body: { type: 'string', maxLenght: 3 } };
    });
  await app.init();
  await expect(app.getHttpAdapter().getInstance().ready()).rejects.toThrow(/maxLenght/);
});
