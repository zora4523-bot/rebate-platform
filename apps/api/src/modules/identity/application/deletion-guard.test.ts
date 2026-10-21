import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it } from 'vitest';
import { createDeletionStageChecks, deletionStageRefusal } from './deletion-guard.ts';

const principal = {
  app_id: 'couli',
  uid: '0199a3b4-5c6d-7e8f-9a0b-000000000001',
  sid: '0199a3b4-5c6d-7e8f-9a0b-000000000002',
  device_id: '0199a3b4-5c6d-7e8f-9a0b-000000000003',
  scp: 'full' as const,
};

// A scripted driver: answers the deletion-stage read with the given rows, no PG connection.
function scriptedDb(rows: unknown[]) {
  const queries: string[] = [];
  const client = {
    release: () => undefined,
    async query(text: string) {
      queries.push(text);
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  return { db, queries };
}

function context(method: string, url: string, withPrincipal = true) {
  const request = {
    id: 'trace',
    method,
    routeOptions: { url },
    headers: {},
    ...(withPrincipal ? { principal } : {}),
  };
  return { switchToHttp: () => ({ getRequest: () => request }) };
}

it('[AC-B1-15e#1] 阶段到拒绝码：none 放行，cooling 为 cooling，processing / done 为 processing', () => {
  expect(deletionStageRefusal('none')).toBeNull();
  expect(deletionStageRefusal('cooling')).toEqual({ code: 10007, stage: 'cooling' });
  expect(deletionStageRefusal('processing')).toEqual({ code: 10007, stage: 'processing' });
  expect(deletionStageRefusal('done')).toEqual({ code: 10007, stage: 'processing' });
});

it('[AC-B1-15e#3] GET、白名单写接口、x-auth none 与契约外路由不读库', async () => {
  const { db, queries } = scriptedDb([]);
  const checks = createDeletionStageChecks({ db });
  for (const [method, url] of [
    ['GET', '/v1/me'],
    ['HEAD', '/v1/me'],
    ['POST', '/v1/auth/logout'],
    ['POST', '/v1/auth/refresh'],
    ['POST', '/v1/consents'],
    ['POST', '/v1/me/deletion/cancel'],
    ['POST', '/v1/idempotency-keys/abandon'],
    ['POST', '/v1/auth/login/sms'],
    ['POST', '/__unknown'],
  ] as const) {
    await expect(checks.guard.canActivate(context(method, url)), `${method} ${url}`).resolves.toBe(
      true,
    );
  }
  expect(queries).toEqual([]);
});

it('[AC-B1-15e#4] 冷静期用户写接口 → 403 10007 stage=cooling；users.status=deleting → processing', async () => {
  const cooling = scriptedDb([{ id: principal.uid, status: 'normal', request_status: 'cooling' }]);
  await expect(
    createDeletionStageChecks({ db: cooling.db }).guard.canActivate(context('PATCH', '/v1/me')),
  ).rejects.toMatchObject({
    status: 403,
    response: { code: 10007, msg: '账号注销处理中', data: { stage: 'cooling' }, trace_id: 'trace' },
  });
  expect(cooling.queries).toHaveLength(1);
  const deleting = scriptedDb([{ id: principal.uid, status: 'deleting', request_status: null }]);
  await expect(
    createDeletionStageChecks({ db: deleting.db }).guard.canActivate(context('PATCH', '/v1/me')),
  ).rejects.toMatchObject({ response: { data: { stage: 'processing' } } });
});

it('[AC-B1-15e#9] 进程无库时判定路由 50001；agent 写接口无令牌不判', async () => {
  const checks = createDeletionStageChecks({ db: null });
  await expect(checks.guard.canActivate(context('PATCH', '/v1/me'))).rejects.toMatchObject({
    code: 50001,
  });
  await expect(
    checks.guard.canActivate(context('POST', '/v1/agent/sessions', false)),
  ).resolves.toBe(true);
  await expect(
    checks.guard.canActivate(context('POST', '/v1/agent/sessions')),
  ).rejects.toMatchObject({ code: 50001 });
});
