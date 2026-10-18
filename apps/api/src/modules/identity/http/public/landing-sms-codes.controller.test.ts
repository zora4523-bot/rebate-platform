import { HttpException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  contractRouteSchema,
  createRootLogger,
  loadConfig,
} from '../../../platform/index.ts';
import type { SmsCodeService, SmsRequest, SmsResult } from '../../application/sms-codes.ts';
import { LandingSmsCodesController } from './landing-sms-codes.controller.ts';

const TRACE = 'abcdefABCDEF01234567abcdefABCDEF';

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function controller(result: SmsResult | null) {
  const send = vi.fn(async (request: SmsRequest) => {
    void request;
    return result!;
  });
  const service = result === null ? null : ({ send } as unknown as SmsCodeService);
  const headers: [string, string][] = [];
  const reply = { header: (name: string, value: string) => headers.push([name, value]) };
  const request = {
    id: TRACE,
    ip: '203.0.113.7',
    headers: { 'x-app-id': 'couli' },
    body: { phone: '+86 139 1234 5678' },
  };
  return { target: new LandingSmsCodesController(service), send, headers, reply, request };
}

it('[AC-B1-11g#1] the landing controller sends a login code of X-App-Id with the client IP and no device', async () => {
  const c = controller({ code: 0, data: { resend_after_sec: 60, expires_in_sec: 300 } });
  const body = await c.target.send(c.request, c.reply);
  expect(body).toEqual({
    code: 0,
    msg: '',
    data: { resend_after_sec: 60, expires_in_sec: 300 },
    trace_id: TRACE,
  });
  expect(c.send).toHaveBeenCalledExactlyOnceWith({
    app_id: 'couli',
    phone: '+86 139 1234 5678',
    purpose: 'login',
    client_ip: '203.0.113.7',
    channel: 'landing',
  });
  expect(c.headers).toEqual([]);
});

it('[AC-B1-11g#8] a landing 42901 sets Retry-After and throws the 429 envelope', async () => {
  const c = controller({ code: 42901, retryAfterSec: 601 });
  const error = await c.target.send(c.request, c.reply).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(429);
  expect((error as HttpException).getResponse()).toMatchObject({ code: 42901, trace_id: TRACE });
  expect(c.headers).toEqual([['Retry-After', '601']]);
});

it('[AC-B1-11g#1] without the service (no Redis or no database) the landing request fails closed', async () => {
  const missing = controller(null);
  await expect(missing.target.send(missing.request, missing.reply)).rejects.toThrow(
    /SMS codes need Redis/,
  );
});

it('[AC-B1-11g#26] the api entry mounts the sendLandingSmsCode contract route schema', async () => {
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-06T02:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  const schemas: unknown[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url === '/v1/landing/sms-codes')
        schemas.push({ method: route.method, schema: route.schema });
    });
  await app.init();
  expect(schemas).toEqual([{ method: 'POST', schema: contractRouteSchema('sendLandingSmsCode') }]);
});
