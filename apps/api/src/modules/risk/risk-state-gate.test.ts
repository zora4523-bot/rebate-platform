// Stage ⑤ assembly of RiskModule (B1-03h §10): with DB and EVENT_BUS, the chained global guard
// judges ④a, then ⑤ (10006), then ⑬ on the non-idempotent operations, and the post-miss hook
// reads on the idempotency claim's transaction; without them stage ⑤ is not installed and one
// info line is logged. A bare Nest app on Fastify (app.inject, no listen) over a scripted pg
// transport; the stage ② principal is attached by a Fastify onRequest hook.
import 'reflect-metadata';
import { Controller, HttpCode, Module, Post, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DB as Database } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CLOCK,
  DB,
  EVENT_BUS,
  FixedClock,
  ROOT_LOGGER,
  createIdempotency,
  createRootLogger,
  registerIdempotencyPostMissCheck,
  type IdempotentRequest,
} from '../platform/index.ts';
import { MINIMUM_VERSION_SCOPE } from './application/minimum-version.ts';
import { createRiskStatePostMissCheck } from './application/risk-state-gate.ts';
import {
  RiskStateBannedException,
  createRiskStateService,
  riskStateServiceToken,
} from './application/risk-state.ts';
import { DEVICE_SIGNING_KEYS } from './application/signature-check.ts';
import { RiskModule } from './risk.module.ts';

const UID = '019a0000-0000-7000-8000-000000000010';
const PRINCIPAL = { uid: UID, app_id: 'couli', sid: 's', device_id: 'd', scp: 'full' };
const HEADERS = {
  'content-type': 'application/json',
  'x-platform': 'ios',
  'x-channel': 'appstore',
  'x-app-id': 'couli',
  'x-app-version': '2.0.0',
};

/** A scripted pool: counts checkouts, logs which client ran which statement, answers a state. */
function scriptedPool(state: string | null) {
  const log: string[] = [];
  let checkouts = 0;
  const pool = {
    async connect() {
      checkouts += 1;
      const client = checkouts;
      return {
        release: () => undefined,
        async query(text: string) {
          log.push(`${client}:${text}`);
          let rows: unknown[] = [];
          if (text.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: true }];
          else if (text.includes('current_setting')) rows = [{ value: '0' }];
          else if (text.includes('user_risk_state') && state !== null)
            rows = [{ state, reason_category: 'other', frozen_until: null, row_version: 0 }];
          return { command: 'SELECT', rowCount: rows.length, rows };
        },
      };
    },
    end: async () => undefined,
    options: {},
  };
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  const riskReads = () => log.filter((line) => line.includes('user_risk_state'));
  return { db, log, riskReads, checkouts: () => checkouts };
}

let reached = 0;

@Controller()
class StubController {
  // Not idempotent: judged by the global guard.
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
const pools: Kysely<Database>[] = [];
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const db of pools.splice(0)) await db.destroy();
});

async function build(options: { state?: string | null; database: boolean; minimum?: string }) {
  reached = 0;
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { entry: 'api', appEnv: 'test', level: 'info' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const pool = scriptedPool(options.state ?? null);
  pools.push(pool.db);
  const publish = vi.fn(async () => ({ eventId: 'e', duplicate: false }));
  const reader = { minSupportedVersion: async () => options.minimum ?? null };
  const infra: DynamicModule = {
    module: class InfraModule {},
    global: true,
    providers: [
      { provide: CLOCK, useValue: new FixedClock('2031-05-06T07:08:09Z') },
      { provide: ROOT_LOGGER, useValue: logger },
      ...(options.database
        ? [
            { provide: DB, useValue: pool.db },
            { provide: EVENT_BUS, useValue: { publish } },
          ]
        : []),
    ],
    exports: [CLOCK, ROOT_LOGGER, ...(options.database ? [DB, EVENT_BUS] : [])],
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
      }),
    ],
  };
  app = await NestFactory.create<NestFastifyApplication>(root, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (request) => {
      (request as unknown as { principal: unknown }).principal = PRINCIPAL;
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
  return { lines, send, pool, app: http };
}

it('[B1-03h §10] a banned principal gets 403 / 10006 from the guard; the handler is not reached', async () => {
  const { send } = await build({ state: 'banned', database: true });
  const response = await send();
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ code: 10006, msg: expect.any(String) });
  expect(response.json()).not.toHaveProperty('data');
  expect(reached).toBe(0);
});

it('[B1-03h §10] a normal principal reaches the handler', async () => {
  const { send } = await build({ state: null, database: true });
  expect((await send()).statusCode).toBe(200);
  expect(reached).toBe(1);
});

it('[B1-03h §10] ④a refuses before ⑤ reads any state', async () => {
  const { send, pool } = await build({ state: 'banned', database: true, minimum: '3.0.0' });
  const response = await send('1.0.0');
  expect(response.json()).toMatchObject({ code: 10405 });
  expect(pool.riskReads()).toEqual([]);
});

it('[B1-03h §10] without DB / EVENT_BUS stage ⑤ is not installed and one info line is logged', async () => {
  const { lines, send, app: http } = await build({ state: 'banned', database: false });
  const disabled = lines.filter((line) => line['msg'] === 'risk_state_gate_disabled');
  expect(disabled).toHaveLength(1);
  expect(disabled[0]).toMatchObject({ level: 30, stage: '5' });
  expect(http.get(riskStateServiceToken())).toBeNull();
  expect((await send()).statusCode).toBe(200);
});

it('[B1-03h §10] the DI token resolves the service the guard uses', async () => {
  const { app: http } = await build({ state: null, database: true });
  const service = http.get<{ checkRequest: unknown }>(riskStateServiceToken());
  expect(typeof service.checkRequest).toBe('function');
});

it('[B1-03h §10] the post-miss hook judges nothing outside an HTTP request scope', async () => {
  const check = vi.fn(async () => undefined);
  const hook = createRiskStatePostMissCheck({
    checkRequest: check,
    readRiskState: vi.fn(),
    setRiskState: vi.fn(),
  });
  await expect(hook({} as never)).resolves.toBeUndefined();
  expect(check).not.toHaveBeenCalled();
});

for (const mode of ['execute', 'executeInTransaction'] as const) {
  it(`[B1-03h §10] ${mode}: the post-miss hook reads the state on the claim's transaction, never on a second pooled connection`, async () => {
    const { db, riskReads, checkouts } = scriptedPool('banned');
    pools.push(db);
    const clock = new FixedClock('2031-01-01T00:00:00Z');
    const idempotency = createIdempotency({ db, clock, logger: { warn: () => undefined } });
    const service = createRiskStateService({
      db,
      clock,
      events: { publish: vi.fn(async () => ({ eventId: 'e', duplicate: false })) },
    });
    registerIdempotencyPostMissCheck(idempotency, createRiskStatePostMissCheck(service));
    const input: IdempotentRequest = {
      appId: 'couli',
      actor: { userId: UID, deviceId: null, phoneHmac: null },
      method: 'POST',
      path: '/v1/links/l/open',
      key: '019a0000-0000-7000-8000-0000000000aa',
      body: {},
      traceId: 'trace-1',
    };
    const handler = vi.fn(async () => ({
      status: 200,
      envelope: { code: 0, msg: '', trace_id: 'trace-1' },
    }));
    const scope = {
      request: {
        id: 'trace-1',
        method: 'POST',
        headers: {},
        routeOptions: { url: '/v1/links/:link_id/open' },
        principal: { ...PRINCIPAL, scp: 'full' as const },
      },
      idempotencyEntered: true,
    };
    await MINIMUM_VERSION_SCOPE.run(scope, async () => {
      await expect(
        mode === 'execute'
          ? idempotency.execute(input, handler)
          : idempotency.executeInTransaction(input, handler),
      ).rejects.toBeInstanceOf(RiskStateBannedException);
    });
    expect(checkouts()).toBe(1);
    expect(riskReads().length).toBeGreaterThan(0);
    expect(riskReads().every((line) => line.startsWith('1:'))).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
}
