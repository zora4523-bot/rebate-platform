import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { HttpException } from '@nestjs/common';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  contractRouteSchema,
  createRootLogger,
  loadConfig,
} from '../../../platform/index.ts';
import type { RefreshResult, RefreshService } from '../../application/refresh.ts';
import { RefreshController, refreshErrorResponse } from './refresh.controller.ts';

const TRACE = 'b102k000000000000000000000000001';
const PAIR = {
  access_token: 'a',
  access_expires_at: '2026-10-08T06:00:00.000Z',
  refresh_token: 'r',
  refresh_expires_at: '2026-11-07T04:00:00.000Z',
  session_scope: 'full',
} as const;

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function request(headers: Record<string, string> = {}) {
  return {
    id: TRACE,
    headers: {
      'x-platform': 'android',
      'x-channel': 'huawei',
      'x-app-version': '2.1.0',
      ...headers,
    },
    body: { refresh_token: 'presented' },
    verifiedDevice: { deviceId: 'device-1', appId: 'couli' },
  };
}

it('[BR-ID-07][04 §6.1] the api entry mounts refresh with its contract schema', async () => {
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-08T04:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  const schemas: unknown[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url === '/v1/auth/refresh')
        schemas.push({ method: route.method, schema: route.schema });
    });
  await app.init();
  expect(schemas).toEqual([{ method: 'POST', schema: contractRouteSchema('refreshToken') }]);
});

it("[BR-ID-07] the verified device and this request's client headers reach the service", async () => {
  const refresh = vi.fn<RefreshService['refresh']>(async () => ({ code: 0, data: PAIR }));
  const controller = new RefreshController({ refresh });
  expect(await controller.refresh(request())).toEqual({
    code: 0,
    msg: '',
    data: PAIR,
    trace_id: TRACE,
  });
  expect(refresh).toHaveBeenCalledWith({
    refresh_token: 'presented',
    verifiedDevice: { deviceId: 'device-1', appId: 'couli' },
    platform: 'android',
    channel: 'huawei',
    version: '2.1.0',
  });
});

it('[BR-ID-07] 10404 answers 401 and 50001 answers 500, both without data', async () => {
  for (const [code, status] of [
    [10404, 401],
    [50001, 500],
  ] as const) {
    const controller = new RefreshController({
      refresh: async (): Promise<RefreshResult> => ({ code }),
    });
    const error = await controller.refresh(request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(status);
    expect((error as HttpException).getResponse()).toEqual(
      refreshErrorResponse({ code }, TRACE).body,
    );
    expect(refreshErrorResponse({ code }, TRACE)).toEqual({
      statusCode: status,
      body: { code, msg: expect.any(String), trace_id: TRACE },
    });
  }
});

it('[BR-ID-07] without its stores the route fails closed instead of answering', async () => {
  const controller = new RefreshController(null);
  await expect(controller.refresh(request())).rejects.toThrow(/refresh needs/);
});
