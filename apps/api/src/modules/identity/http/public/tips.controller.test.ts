import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  contractRouteSchema,
  createRootLogger,
  loadConfig,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import type { TipsService } from '../../application/tips.ts';
import { TipsController } from './tips.controller.ts';

const TRACE = 'b1025000000000000000000000000001';
const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000010',
  app_id: 'couli',
  sid: 'session-unit',
  device_id: '019a0000-0000-7000-8000-000000000001',
  scp: 'full',
};
const HEADERS = {
  'x-app-id': 'couli',
  'x-platform': 'ios',
  'x-app-version': '2.0.0',
  'x-device-id': PRINCIPAL.device_id,
  'x-trace-id': TRACE,
};
const SUBJECT = { app_id: 'couli', user_id: PRINCIPAL.uid };

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function fakeService() {
  return {
    read: vi.fn<TipsService['read']>(async () => ({
      jump_tip: { taobao: '2031-05-06T07:08:09.123Z' },
      inviter_before_buy: null,
    })),
    markRead: vi.fn<TipsService['markRead']>(async () => ({ code: 0 as const })),
    resetJumpTip: vi.fn<TipsService['resetJumpTip']>(async () => undefined),
  };
}

it('[AC-B1-02s] the api entry mounts the three tip routes with their contract schemas behind the token check', async () => {
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2031-05-06T07:08:09.123Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  const schemas: unknown[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      // Fastify adds a HEAD route beside each GET.
      if (route.url.startsWith('/v1/me/tips') && route.method !== 'HEAD')
        schemas.push({ method: route.method, url: route.url, schema: route.schema });
    });
  await app.init();
  expect(schemas).toEqual([
    { method: 'GET', url: '/v1/me/tips', schema: contractRouteSchema('getTips') },
    {
      method: 'POST',
      url: '/v1/me/tips/:tip_key/read',
      schema: contractRouteSchema('markTipRead'),
    },
    { method: 'DELETE', url: '/v1/me/tips/:tip_key', schema: contractRouteSchema('resetTip') },
  ]);
  expect(contractRouteSchema('markTipRead')).not.toHaveProperty('body');
  for (const [method, url] of [
    ['GET', '/v1/me/tips'],
    ['POST', '/v1/me/tips/jump_tip/read'],
    ['DELETE', '/v1/me/tips/jump_tip'],
  ] as const) {
    const guest = await app.inject({ method, url, headers: HEADERS });
    expect(guest.statusCode).toBe(401);
    expect(guest.json()).toEqual({ code: 10001, msg: '未登录', trace_id: TRACE });
  }
});

it('[AC-B1-02s] GET answers the token subject’s read states', async () => {
  const service = fakeService();
  const controller = new TipsController(service);
  await expect(controller.getTips({ id: TRACE, principal: PRINCIPAL })).resolves.toEqual({
    code: 0,
    msg: '',
    data: { jump_tip: { taobao: '2031-05-06T07:08:09.123Z' }, inviter_before_buy: null },
    trace_id: TRACE,
  });
  expect(service.read).toHaveBeenCalledWith(SUBJECT);
});

it('[AC-B1-02s] POST passes the tip key and body to the use case and answers EmptyResponse', async () => {
  const service = fakeService();
  const controller = new TipsController(service);
  const body = { platform: 'jd' };
  await expect(
    controller.markTipRead({
      id: TRACE,
      principal: PRINCIPAL,
      params: { tip_key: 'jump_tip' },
      body,
    }),
  ).resolves.toEqual({ code: 0, msg: '', data: {}, trace_id: TRACE });
  expect(service.markRead).toHaveBeenCalledWith(SUBJECT, 'jump_tip', body);
});

it('[AC-B1-02s] POST maps a refused body to 20001 with data.fields', async () => {
  const service = fakeService();
  service.markRead.mockResolvedValueOnce({ code: 20001, data: { fields: ['platform'] } });
  const controller = new TipsController(service);
  const failure = await controller
    .markTipRead({ id: TRACE, principal: PRINCIPAL, params: { tip_key: 'jump_tip' } })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({
    status: 400,
    response: { code: 20001, data: { fields: ['platform'] }, trace_id: TRACE },
  });
});

it('[AC-B1-02s] POST and DELETE refuse a tip key outside their enum without touching the store', async () => {
  const service = fakeService();
  const controller = new TipsController(service);
  await expect(
    controller.markTipRead({ id: TRACE, principal: PRINCIPAL, params: { tip_key: 'unknown' } }),
  ).rejects.toMatchObject({ status: 400, response: { code: 20001 } });
  await expect(
    controller.resetTip({
      id: TRACE,
      principal: PRINCIPAL,
      params: { tip_key: 'inviter_before_buy' },
    }),
  ).rejects.toMatchObject({ status: 400, response: { code: 20001 } });
  expect(service.markRead).not.toHaveBeenCalled();
  expect(service.resetJumpTip).not.toHaveBeenCalled();
});

it('[AC-B1-02s] DELETE jump_tip clears the subject’s jump_tip records', async () => {
  const service = fakeService();
  const controller = new TipsController(service);
  await expect(
    controller.resetTip({ id: TRACE, principal: PRINCIPAL, params: { tip_key: 'jump_tip' } }),
  ).resolves.toEqual({ code: 0, msg: '', data: {}, trace_id: TRACE });
  expect(service.resetJumpTip).toHaveBeenCalledWith(SUBJECT);
});

it('[AC-B1-02s] without a verified principal the handlers answer 10001 and never call the store', async () => {
  const service = fakeService();
  const controller = new TipsController(service);
  await expect(controller.getTips({ id: TRACE })).rejects.toMatchObject({
    status: 401,
    response: { code: 10001 },
  });
  expect(service.read).not.toHaveBeenCalled();
});

it('[AC-B1-02s] without a database the handlers fail closed', async () => {
  const controller = new TipsController(null);
  await expect(controller.getTips({ id: TRACE, principal: PRINCIPAL })).rejects.toThrow(
    /need the database/,
  );
});
