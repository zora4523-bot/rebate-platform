// Stage ⑬ assembly of RiskModule (B1-03e §10): with REDIS, one global guard judges ④a then ⑬ on
// the non-idempotent operations and a 42901 carries Retry-After; without REDIS stage ⑬ is not
// installed and one info line is logged. A bare Nest app on Fastify (app.inject, no listen) with a
// scripted Redis handle; Nest's own exception handling writes the HttpExceptions back.
import 'reflect-metadata';
import { Controller, HttpCode, Module, Post, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CLOCK,
  FixedClock,
  REDIS,
  ROOT_LOGGER,
  createIdempotency,
  createRootLogger,
  registerIdempotencyPostMissCheck,
  type IdempotentRequest,
  type RedisHandle,
} from '../platform/index.ts';
import { MINIMUM_VERSION_SCOPE } from './application/minimum-version.ts';
import {
  RateLimitedException,
  createRateLimitPostMissCheck,
  rateLimitRequestOf,
  type RateLimitHttpRequest,
} from './application/rate-limit-gate.ts';
import {
  createRateLimitService,
  createRateLimitThresholdReader,
  type RateLimitConfigReader,
  type RateLimitService,
} from './application/rate-limit.ts';
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
            useFactory: () => {
              const thresholds = createRateLimitThresholdReader({
                configValue: async (_app, key) =>
                  key === 'rate_limit.ops'
                    ? { value: { recordConsent: 'consents' }, version: 1 }
                    : key === 'rate_limit.consents'
                      ? { value: { ip: [{ limit: 1, window_sec: 60 }] }, version: 1 }
                      : null,
              });
              return { pooled: thresholds, on: () => thresholds };
            },
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

/** A scripted pool: counts connection checkouts and logs which client ran which statement. */
function scriptedPool() {
  const log: string[] = [];
  let checkouts = 0;
  const pool = {
    async connect() {
      checkouts += 1;
      const client = checkouts;
      return {
        release: () => undefined,
        async query(text: string, params: readonly unknown[] = []) {
          log.push(`${client}:${text}`);
          let rows: unknown[] = [];
          if (text.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: true }];
          else if (text.includes('current_setting')) rows = [{ value: '0' }];
          else if (text.includes('config_items') && params.includes('rate_limit.ops'))
            rows = [{ value: { openLink: 'limited' }, version: 1 }];
          else if (text.includes('config_items') && params.includes('rate_limit.limited'))
            rows = [{ value: { ip: [{ limit: 1, window_sec: 60 }] }, version: 1 }];
          return { command: 'SELECT', rowCount: rows.length, rows };
        },
      };
    },
    end: async () => undefined,
    options: {},
  };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  return { db, log, checkouts: () => checkouts };
}

for (const mode of ['execute', 'executeInTransaction'] as const) {
  it(`[B1-03e §11] ${mode}: the post-miss hook reads the thresholds on the claim's transaction, never on a second pooled connection`, async () => {
    const { db, log, checkouts } = scriptedPool();
    const clock = new FixedClock('2031-01-01T00:00:00Z');
    const idempotency = createIdempotency({ db, clock, logger: { warn: () => undefined } });
    const pooledRead = vi.fn(async () => null);
    const handles: Kysely<DB>[] = [];
    const thresholdsOn = (handle: Kysely<DB>) => {
      handles.push(handle);
      return createRateLimitThresholdReader({
        async configValue(appId, key) {
          const row = await handle
            .selectFrom('config_items')
            .select(['value', 'version'])
            .where('app_id', '=', appId)
            .where('key', '=', key)
            .executeTakeFirst();
          return row === undefined ? null : { value: row.value, version: row.version };
        },
      });
    };
    const redis = scripted([0, 2_500]);
    const service = createRateLimitService({
      clock,
      redis: redis.handle,
      logger: createRootLogger({ entry: 'api', appEnv: 'test', level: 'silent' }),
      thresholds: createRateLimitThresholdReader({ configValue: pooledRead }),
    });
    registerIdempotencyPostMissCheck(
      idempotency,
      createRateLimitPostMissCheck(service, thresholdsOn),
    );
    const input: IdempotentRequest = {
      appId: 'couli',
      actor: { userId: '019a0000-0000-7000-8000-000000000010', deviceId: null, phoneHmac: null },
      method: 'POST',
      path: mode === 'execute' ? '/v1/links/l/open' : '/v1/withdrawals',
      key: '019a0000-0000-7000-8000-0000000000aa',
      body: {},
      traceId: 'trace-1',
    };
    const handler = vi.fn(async () => ({
      status: 200,
      envelope: { code: 0, msg: '', trace_id: 'trace-1' },
    }));
    const headers: [string, string][] = [];
    const reply = { header: (name: string, value: string) => headers.push([name, value]) };
    const scope = {
      request: httpRequest({ routeOptions: { url: '/v1/links/:link_id/open' } }),
      reply,
      idempotencyEntered: true,
    };
    await MINIMUM_VERSION_SCOPE.run(scope, async () => {
      await expect(
        mode === 'execute'
          ? idempotency.execute(input, handler)
          : idempotency.executeInTransaction(input, handler),
      ).rejects.toMatchObject({ status: 429, retryAfterSec: 3 });
    });
    expect(checkouts()).toBe(1);
    expect(pooledRead).not.toHaveBeenCalled();
    expect(handles).toHaveLength(1);
    expect(handles[0]).not.toBe(db);
    const reads = log.filter((line) => line.includes('config_items'));
    expect(reads).toHaveLength(2);
    expect(reads.every((line) => line.startsWith('1:'))).toBe(true);
    expect(redis.evals).toHaveLength(1);
    expect(headers).toEqual([['Retry-After', '3']]);
    expect(handler).not.toHaveBeenCalled();
    await db.destroy();
  });
}

it('[B1-03e §11] the guard path reads the thresholds through the pooled reader', async () => {
  const redis = scripted([1, 0]);
  const pooled = vi.fn<RateLimitConfigReader['configValue']>(async () => null);
  const service = createRateLimitService({
    clock: new FixedClock('2031-01-01T00:00:00Z'),
    redis: redis.handle,
    logger: createRootLogger({ entry: 'api', appEnv: 'test', level: 'silent' }),
    thresholds: createRateLimitThresholdReader({ configValue: pooled }),
  });
  expect(
    await service.check({
      entry: 'api',
      operationId: 'searchProducts',
      app_id: 'couli',
      client_ip: '192.0.2.7',
    }),
  ).toEqual({ code: 0 });
  // Anonymous, no device: only the IP dimension is read.
  expect(pooled.mock.calls.map(([, key]) => key)).toEqual(['rate_limit.ops', 'rate_limit.search']);
  expect(redis.evals).toHaveLength(1);
});
