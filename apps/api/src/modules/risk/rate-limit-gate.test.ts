// Stage ⑬ assembly of RiskModule (B1-03e §10): with REDIS, one global guard judges ④a then ⑬ on
// the non-idempotent operations and a 42901 carries Retry-After; without REDIS stage ⑬ is not
// installed and one info line is logged. A bare Nest app on Fastify (app.inject, no listen) with a
// scripted Redis handle; Nest's own exception handling writes the HttpExceptions back.
import 'reflect-metadata';
import { Controller, HttpCode, Module, Post, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it } from 'vitest';
import {
  CLOCK,
  FixedClock,
  REDIS,
  ROOT_LOGGER,
  createRootLogger,
  type RedisHandle,
} from '../platform/index.ts';
import { MINIMUM_VERSION_SCOPE } from './application/minimum-version.ts';
import {
  RateLimitedException,
  createRateLimitPostMissCheck,
  rateLimitRequestOf,
  type RateLimitHttpRequest,
} from './application/rate-limit-gate.ts';
import { createRateLimitThresholdReader, type RateLimitService } from './application/rate-limit.ts';
import { DEVICE_SIGNING_KEYS } from './application/signature-check.ts';
import { RiskModule } from './risk.module.ts';

const HEADERS = {
  'content-type': 'application/json',
  'x-platform': 'ios',
  'x-channel': 'appstore',
  'x-app-id': 'couli',
  'x-app-version': '2.0.0',
};

let reached = 0;

@Controller()
class StubController {
  // Not idempotent: judged by the global guard (④a, then ⑬).
  @Post('/v1/consents')
  @HttpCode(200)
  consent() {
    reached += 1;
    return { code: 0, msg: 'ok', trace_id: 'stub', data: null };
  }
}

@Module({ controllers: [StubController] })
class StubRoutesModule {}

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(options: { redis?: RedisHandle; minimum?: string | null }) {
  reached = 0;
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { entry: 'api', appEnv: 'test', level: 'info' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const reader = { minSupportedVersion: async () => options.minimum ?? null };
  const infra: DynamicModule = {
    module: class InfraModule {},
    global: true,
    providers: [
      { provide: CLOCK, useValue: new FixedClock('2031-05-06T07:08:09Z') },
      { provide: ROOT_LOGGER, useValue: logger },
      ...(options.redis === undefined ? [] : [{ provide: REDIS, useValue: options.redis }]),
    ],
    exports: [CLOCK, ROOT_LOGGER, ...(options.redis === undefined ? [] : [REDIS])],
  };
  const devices: DynamicModule = {
    module: class DevicesModule {},
    providers: [{ provide: DEVICE_SIGNING_KEYS, useValue: { findActive: async () => null } }],
    exports: [DEVICE_SIGNING_KEYS],
  };
  const root: DynamicModule = {
    module: class RootModule {},
    imports: [
      infra,
      StubRoutesModule,
      RiskModule.forRoot({
        imports: [devices],
        minimumVersions: { inject: [], useFactory: () => ({ pooled: reader, on: () => reader }) },
        rateLimit: {
          thresholds: {
            inject: [],
            useFactory: () =>
              createRateLimitThresholdReader({
                configValue: async (_app, key) =>
                  key === 'rate_limit.ops'
                    ? { value: { recordConsent: 'consents' }, version: 1 }
                    : key === 'rate_limit.consents'
                      ? { value: { ip: [{ limit: 1, window_sec: 60 }] }, version: 1 }
                      : null,
              }),
          },
        },
      }),
    ],
  };
  app = await NestFactory.create<NestFastifyApplication>(root, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const http = app;
  const send = (version = '2.0.0') =>
    http.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: { ...HEADERS, 'x-app-version': version },
      payload: JSON.stringify({ type: 'marketing', accepted: true }),
    });
  return { lines, send };
}

function scripted(reply: unknown) {
  const evals: unknown[] = [];
  const handle: RedisHandle = {
    namespace: () => ({
      get: () => Promise.reject(new Error('unused')),
      set: () => Promise.reject(new Error('unused')),
      eval: async (_script, options) => {
        evals.push(options);
        return reply;
      },
    }),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  return { handle, evals };
}

it('[B1-03e §10] a refused request answers 429 / 42901 with Retry-After in whole seconds', async () => {
  const redis = scripted([0, 4_001]);
  const { send } = await build({ redis: redis.handle });
  const response = await send();
  expect(response.statusCode).toBe(429);
  expect(response.headers['retry-after']).toBe('5');
  expect(response.json()).toMatchObject({ code: 42901, msg: expect.any(String) });
  expect(reached).toBe(0);
  expect(redis.evals).toHaveLength(1);
});

it('[B1-03e §10] ④a refuses before ⑬ reads any bucket', async () => {
  const redis = scripted([0, 4_001]);
  const { send } = await build({ redis: redis.handle, minimum: '3.0.0' });
  const response = await send('1.0.0');
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ code: 10405 });
  expect(redis.evals).toEqual([]);
});

it('[B1-03e §10] an allowed request reaches the handler', async () => {
  const redis = scripted([1, 0]);
  const { send } = await build({ redis: redis.handle });
  expect((await send()).statusCode).toBe(200);
  expect(reached).toBe(1);
});

it('[B1-03e §10] without REDIS stage ⑬ is not installed and one info line is logged', async () => {
  const { lines, send } = await build({});
  const disabled = lines.filter((line) => line['msg'] === 'rate_limit_disabled');
  expect(disabled).toHaveLength(1);
  expect(disabled[0]).toMatchObject({ level: 30, stage: '13' });
  for (let i = 0; i < 3; i++) expect((await send()).statusCode).toBe(200);
});

function httpRequest(overrides: Partial<RateLimitHttpRequest> = {}): RateLimitHttpRequest {
  return {
    id: 'trace-1',
    method: 'POST',
    headers: { 'x-app-id': 'couli', 'x-device-id': 'unverified-header' },
    routeOptions: { url: '/v1/inputs/parse' },
    ip: '192.0.2.7',
    ...overrides,
  };
}

it('[B1-03e §10] the HTTP input: contract operationId, verified identities only, Fastify ip', () => {
  expect(rateLimitRequestOf(httpRequest())).toEqual({
    entry: 'api',
    operationId: 'parseInput',
    app_id: 'couli',
    client_ip: '192.0.2.7',
  });
  expect(rateLimitRequestOf(httpRequest({ routeOptions: { url: '/v1/unknown' } }))).toBeUndefined();
  const device = { deviceId: 'dev-1', appId: 'other_app' };
  expect(
    rateLimitRequestOf({ ...httpRequest(), verifiedDevice: device } as RateLimitHttpRequest),
  ).toMatchObject({ app_id: 'other_app', verifiedDevice: device });
});

it('[B1-03e §10] the post-miss hook judges the scoped request and sets Retry-After on its reply', async () => {
  const service: RateLimitService = {
    check: async () => ({ code: 42901, retryAfterSec: 7 }),
  };
  const hook = createRateLimitPostMissCheck(service);
  const headers: [string, string][] = [];
  const reply = { header: (name: string, value: string) => headers.push([name, value]) };
  // Outside an HTTP request scope (a job): nothing to judge.
  await expect(hook({} as never)).resolves.toBeUndefined();
  const scope = { request: httpRequest(), reply, idempotencyEntered: true };
  const refused = MINIMUM_VERSION_SCOPE.run(scope, () => hook({} as never));
  await expect(refused).rejects.toBeInstanceOf(RateLimitedException);
  await expect(refused).rejects.toMatchObject({ retryAfterSec: 7 });
  expect(headers).toEqual([['Retry-After', '7']]);
});
