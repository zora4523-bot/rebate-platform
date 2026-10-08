// Stage ④a assembly of RiskModule on an entry with and without a minimum version reader (B1-03c
// §13): without one (no database: tests and the contract smoke only) the gate is not installed and
// an info line is logged at startup; with one that fails, every judged request still fails closed.
// A bare Nest app on the platform's Fastify adapter and error filter; app.inject, no listen.
import 'reflect-metadata';
import { Controller, HttpCode, Module, Post, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it } from 'vitest';
import { GlobalErrorFilter, PlatformFastifyAdapter } from '../platform/http/global-errors.ts';
import { idempotencyHooksOf } from '../platform/idempotency/index.ts';
import {
  CLOCK,
  FixedClock,
  IDEMPOTENCY,
  ROOT_LOGGER,
  createIdempotency,
  createRootLogger,
  type Idempotency,
} from '../platform/index.ts';
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

@Controller()
class StubController {
  // Idempotent in the contract; this stub answers without the IDEMPOTENCY instance, as the
  // LinkOpenService stubs of test/spec/linking/open-jdpdd/http.test.ts do.
  @Post('/v1/links/:link_id/open')
  @HttpCode(200)
  open() {
    return { code: 0, msg: 'ok', trace_id: 'stub', data: null };
  }

  // Not idempotent, conditional gate: judged by the global guard.
  @Post('/v1/consents')
  @HttpCode(200)
  consent() {
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

async function build(minimumVersions: MinimumVersionReaders | null) {
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { entry: 'api', appEnv: 'test', level: 'info' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const clock = new FixedClock('2026-10-01T00:00:00Z');
  const idempotency: Idempotency = createIdempotency({ db: {} as never, clock, logger });
  const infra: DynamicModule = {
    module: class InfraModule {},
    global: true,
    providers: [
      { provide: CLOCK, useValue: clock },
      { provide: ROOT_LOGGER, useValue: logger },
      { provide: IDEMPOTENCY, useValue: idempotency },
    ],
    exports: [CLOCK, ROOT_LOGGER, IDEMPOTENCY],
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
  const adapter = new PlatformFastifyAdapter({ loggerInstance: logger });
  app = await NestFactory.create<NestFastifyApplication>(root, adapter, {
    logger: false,
    abortOnError: false,
  });
  app.useGlobalFilters(new GlobalErrorFilter(app.getHttpAdapter(), logger));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const http = app;
  const send = (url: string, payload: object) =>
    http.inject({ method: 'POST', url, headers: GATED_HEADERS, payload: JSON.stringify(payload) });
  return { lines, idempotency, send };
}

it('[B1-03c §13#1] no minimum version reader: guard, interceptor and hooks not installed, one startup info log', async () => {
  const { lines, idempotency, send } = await build(null);

  const disabled = lines.filter((line) => line['msg'] === 'minimum_version_gate_disabled');
  expect(disabled).toHaveLength(1);
  expect(disabled[0]).toMatchObject({ level: 30, entry: 'api', stage: '4a' });
  expect(idempotencyHooksOf(idempotency)).toEqual({ postMiss: [], entry: [] });

  // Idempotent stub route answering without the IDEMPOTENCY instance: no fail-closed 50001.
  const opened = await send(OPEN, { installed: 'unknown' });
  expect(opened.statusCode).toBe(200);
  expect(opened.json()).toMatchObject({ code: 0 });
  // Non-idempotent gated operation below any minimum: no guard judges it.
  const consented = await send('/v1/consents', { type: 'marketing', accepted: true });
  expect(consented.statusCode).toBe(200);
  expect(consented.json()).toMatchObject({ code: 0 });
});

it('[B1-03c §13#2] a wired reader that fails still fails closed with 50001 on both paths', async () => {
  const failing = {
    minSupportedVersion: () => Promise.reject(new Error('read failed')),
  };
  const { lines, idempotency, send } = await build({ pooled: failing, on: () => failing });

  expect(lines.some((line) => line['msg'] === 'minimum_version_gate_disabled')).toBe(false);
  const hooks = idempotencyHooksOf(idempotency);
  expect(hooks?.postMiss).toHaveLength(1);
  expect(hooks?.entry).toHaveLength(1);

  // Idempotent route whose handler never reached the IDEMPOTENCY instance.
  const opened = await send(OPEN, { installed: 'unknown' });
  expect(opened.statusCode).toBe(500);
  expect(opened.json()).toMatchObject({ code: 50001 });
  // Non-idempotent gated operation: the guard's read fails, never read as "no minimum".
  const consented = await send('/v1/consents', { type: 'marketing', accepted: true });
  expect(consented.statusCode).toBe(500);
  expect(consented.json()).toMatchObject({ code: 50001 });
});
