// Stage ④a assembly of RiskModule on an entry with and without a minimum version reader (B1-03c
// §13): without one (no database: tests and the contract smoke only) the gate is not installed and
// an info line is logged at startup; with one that fails, every judged request still fails closed.
// A bare Nest app on Fastify (app.inject, no listen). A recording exception filter stands in for
// the platform's global filter, which maps any unhandled error to 500 / 50001 (its own tests):
// these tests assert which error reached it. Only platform/index.ts is imported (module boundary).
import 'reflect-metadata';
import {
  Catch,
  Controller,
  HttpCode,
  Module,
  Post,
  type ArgumentsHost,
  type DynamicModule,
  type ExceptionFilter,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it } from 'vitest';
import {
  CLOCK,
  FixedClock,
  IDEMPOTENCY,
  ROOT_LOGGER,
  createRootLogger,
} from '../platform/index.ts';
import { MinimumVersionUnjudgedError } from './application/minimum-version.ts';
import { DEVICE_SIGNING_KEYS } from './application/signature-check.ts';
import { RiskModule, type MinimumVersionReaders } from './risk.module.ts';

const OPEN = '/v1/links/019a0000-0000-7000-8000-0000000000e1/open';
/** A gated platform, an old version and a non-exempt body: judged by the guard when installed. */
const GATED_HEADERS = {
  'content-type': 'application/json',
  'x-platform': 'ios',
  'x-channel': 'appstore',
  'x-app-id': 'couli',
  'x-app-version': '0.0.1',
};

/** Handler calls per stub route, reset by build(). */
const reached = { open: 0, consent: 0 };
/** Errors that reached the filter, reset by build(). */
const failures: unknown[] = [];

@Catch()
class RecordingFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    failures.push(exception);
    void host
      .switchToHttp()
      .getResponse<{ code(status: number): { send(body: unknown): unknown } }>()
      .code(500)
      .send({ failed: true });
  }
}

@Controller()
class StubController {
  // Idempotent in the contract; this stub answers without the IDEMPOTENCY instance, as the
  // LinkOpenService stubs of test/spec/linking/open-jdpdd/http.test.ts do.
  @Post('/v1/links/:link_id/open')
  @HttpCode(200)
  open() {
    reached.open += 1;
    return { code: 0, msg: 'ok', trace_id: 'stub', data: null };
  }

  // Not idempotent, conditional gate: judged by the global guard.
  @Post('/v1/consents')
  @HttpCode(200)
  consent() {
    reached.consent += 1;
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

/**
 * `idempotency`: a stand-in IDEMPOTENCY object. It is not a createIdempotency instance, so a hook
 * registration on it throws at startup (registerIdempotencyPostMissCheck refuses it).
 */
async function build(minimumVersions: MinimumVersionReaders | null, idempotency?: object) {
  reached.open = 0;
  reached.consent = 0;
  failures.length = 0;
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { entry: 'api', appEnv: 'test', level: 'info' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const clock = new FixedClock('2026-10-01T00:00:00Z');
  const infra: DynamicModule = {
    module: class InfraModule {},
    global: true,
    providers: [
      { provide: CLOCK, useValue: clock },
      { provide: ROOT_LOGGER, useValue: logger },
      ...(idempotency === undefined ? [] : [{ provide: IDEMPOTENCY, useValue: idempotency }]),
    ],
    exports: [CLOCK, ROOT_LOGGER, ...(idempotency === undefined ? [] : [IDEMPOTENCY])],
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
        minimumVersions: { inject: [], useFactory: () => minimumVersions },
      }),
    ],
  };
  app = await NestFactory.create<NestFastifyApplication>(root, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  app.useGlobalFilters(new RecordingFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const http = app;
  const send = (url: string, payload: object) =>
    http.inject({ method: 'POST', url, headers: GATED_HEADERS, payload: JSON.stringify(payload) });
  return { lines, send };
}

it('[B1-03c §13#1] no minimum version reader: guard, interceptor and hooks not installed, one startup info log', async () => {
  // Startup succeeds with an IDEMPOTENCY that refuses registration: no hook was registered.
  const { lines, send } = await build(null, {});

  const disabled = lines.filter((line) => line['msg'] === 'minimum_version_gate_disabled');
  expect(disabled).toHaveLength(1);
  expect(disabled[0]).toMatchObject({ level: 30, entry: 'api', stage: '4a' });

  // Idempotent stub route answering without the IDEMPOTENCY instance: no fail-closed error.
  const opened = await send(OPEN, { installed: 'unknown' });
  expect(opened.statusCode).toBe(200);
  expect(opened.json()).toMatchObject({ code: 0 });
  // Non-idempotent gated operation below any minimum: no guard judges it.
  const consented = await send('/v1/consents', { type: 'marketing', accepted: true });
  expect(consented.statusCode).toBe(200);
  expect(consented.json()).toMatchObject({ code: 0 });
  expect(reached).toEqual({ open: 1, consent: 1 });
  expect(failures).toEqual([]);
});

it('[B1-03c §13#2] a wired reader that fails still fails closed on both paths (500 / 50001 through the global filter)', async () => {
  const failing = {
    minSupportedVersion: () => Promise.reject(new Error('read failed')),
  };
  const { lines, send } = await build({ pooled: failing, on: () => failing });

  expect(lines.some((line) => line['msg'] === 'minimum_version_gate_disabled')).toBe(false);

  // Idempotent route whose handler never reached an IDEMPOTENCY instance: its result is dropped.
  const opened = await send(OPEN, { installed: 'unknown' });
  expect(opened.statusCode).toBe(500);
  expect(failures[0]).toBeInstanceOf(MinimumVersionUnjudgedError);
  // Non-idempotent gated operation: the guard's read fails, never read as "no minimum".
  const consented = await send('/v1/consents', { type: 'marketing', accepted: true });
  expect(consented.statusCode).toBe(500);
  expect(failures[1]).toMatchObject({ message: 'read failed' });
  expect(failures).toHaveLength(2);
  expect(reached).toEqual({ open: 1, consent: 0 });
});
