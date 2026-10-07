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
import type { TokenService } from '../../application/access-tokens.ts';
import { createLogout } from '../../application/logout.ts';
import { TOKEN_SERVICE } from '../../application/tokens.ts';
import { LogoutController } from './logout.controller.ts';

const TRACE = 'b102a000000000000000000000000001';
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

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build() {
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-06T04:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  const schemas: unknown[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url === '/v1/auth/logout')
        schemas.push({ method: route.method, schema: route.schema });
    });
  await app.init();
  return { app, schemas };
}

it('[BR-ID-07][04 §6.1] the api entry mounts logout with its contract schema behind the token check', async () => {
  const { app: target, schemas } = await build();
  expect(schemas).toEqual([{ method: 'POST', schema: contractRouteSchema('logout') }]);
  const missing = await target.inject({ method: 'POST', url: '/v1/auth/logout', headers: HEADERS });
  expect(missing.statusCode).toBe(401);
  expect(missing.json()).toEqual({ code: 10001, msg: '未登录', trace_id: TRACE });
});

it('[BR-ID-01] without a database a valid token fails closed (50001): the session is never assumed live', async () => {
  const { app: target } = await build();
  const token = await target.get<TokenService>(TOKEN_SERVICE).issueAccess(PRINCIPAL);
  const response = await target.inject({
    method: 'POST',
    url: '/v1/auth/logout',
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toMatchObject({ code: 50001, trace_id: TRACE });
});

it('[BR-ID-07] the handler refuses a request no token check vouched for; a lost race is 10002', async () => {
  const logout = vi.fn(async () => undefined);
  const controller = new LogoutController({ logout });
  await expect(controller.logout({ id: TRACE })).rejects.toThrow(/verified access token/);
  expect(logout).not.toHaveBeenCalled();
  await expect(controller.logout({ id: TRACE, principal: PRINCIPAL })).resolves.toEqual({
    code: 0,
    msg: '',
    data: {},
    trace_id: TRACE,
  });
  expect(logout).toHaveBeenCalledWith(PRINCIPAL);
  // revokeSession found the session already revoked (0 rows): answered like a revoked token.
  const noRows = { executeTakeFirst: async () => ({ numUpdatedRows: 0n }) };
  const chain = { set: () => chain, where: () => chain, ...noRows };
  const db = {
    transaction: () => ({
      execute: (work: (transaction: unknown) => Promise<unknown>) =>
        work({ updateTable: () => chain }),
    }),
  };
  const clock = new FixedClock('2026-10-06T04:00:00.000Z');
  await expect(createLogout({ db: db as never, clock }).logout(PRINCIPAL)).rejects.toMatchObject({
    code: 10002,
    statusCode: 401,
  });
  await expect(createLogout({ db: undefined, clock }).logout(PRINCIPAL)).rejects.toThrow(
    /no database/,
  );
});
