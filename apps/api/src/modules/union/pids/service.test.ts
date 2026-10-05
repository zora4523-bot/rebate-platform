import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { UnionPidError, createUnionPidService, type PidServiceDeps } from './service.ts';

// Local unit-test identifiers; DB behaviour is covered by test/spec/union/pids (integration).
const APP = 'app-unit';
const ADMIN = '00000000-0000-4000-8000-000000000001';
const PID_ID = '00000000-0000-4000-8000-000000000002';
const ctx = { appId: APP, adminId: ADMIN, code: '123456', ip: null };

/** Any database access fails the test: these cases must stop before touching the DB. */
function untouchableDb(): Kysely<DB> {
  return new Proxy({} as Kysely<DB>, {
    get(_target, key) {
      throw new Error(`database used: ${String(key)}`);
    },
  });
}

function setup(verified: Awaited<ReturnType<PidServiceDeps['superVerifier']['verify']>>) {
  const verify = vi.fn<PidServiceDeps['superVerifier']['verify']>(async () => verified);
  const append = vi.fn(async () => undefined);
  const service = createUnionPidService({
    db: untouchableDb(),
    clock: { now: () => new Date('2031-01-01T00:00:00Z') },
    superVerifier: { verify },
    auditWriter: () => ({ append }),
  });
  return { service, verify, append };
}

it('[AC-B1-19b-UNIT#1] 校验未通过时不碰数据库、不写审计', async () => {
  const { service, verify, append } = setup(null);
  await expect(
    service.setPidStatus({ ...ctx, pidId: PID_ID, status: 'active' }),
  ).rejects.toMatchObject({ code: 'not_verified' });
  expect(verify).toHaveBeenCalledExactlyOnceWith({ appId: APP, adminId: ADMIN, code: '123456' });
  expect(append).not.toHaveBeenCalled();
});

it('[AC-B1-19b-UNIT#2] 别的 App 的已验证身份被拒', async () => {
  const { service } = setup({ appId: 'other', adminId: ADMIN });
  await expect(
    service.confirmHjyIgnore({
      ...ctx,
      pidId: PID_ID,
      confirmedAt: new Date('2030-01-01T00:00:00Z'),
      evidencePath: 'x.png',
    }),
  ).rejects.toBeInstanceOf(UnionPidError);
});

it('[AC-B1-19b-UNIT#3] 非法入参在校验动态码之前就被拒，不消耗动态码', async () => {
  const { service, verify } = setup({ appId: APP, adminId: ADMIN });
  const cases: Array<() => Promise<unknown>> = [
    () =>
      service.registerPid({
        ...ctx,
        platform: 'jd',
        unionAccountId: PID_ID,
        siteId: '200',
        pid: '1',
        pidScene: 'self_buy',
      }),
    () =>
      service.registerPid({
        ...ctx,
        platform: 'taobao',
        unionAccountId: PID_ID,
        siteId: null,
        pid: 'mm_1_2_3',
        pidScene: 'self_buy',
      }),
    () =>
      service.registerPid({
        ...ctx,
        platform: 'jd',
        unionAccountId: PID_ID,
        siteId: null,
        pid: '1',
        pidScene: 'search' as never,
      }),
    () =>
      service.confirmHjyIgnore({
        ...ctx,
        pidId: PID_ID,
        confirmedAt: new Date('2030-01-01T00:00:00Z'),
        evidencePath: '  ',
      }),
    () => service.setPidStatus({ ...ctx, pidId: PID_ID, status: 'pending' as never }),
    () => service.setPidStatus({ ...ctx, pidId: 'not-a-uuid', status: 'active' }),
  ];
  for (const run of cases) {
    await expect(run()).rejects.toMatchObject({ code: 'invalid_input' });
  }
  expect(verify).not.toHaveBeenCalled();
});

it('[AC-B1-19b-UNIT#4] fallback 不用于转链，query 位只供查价：不查库直接返回 null', async () => {
  const { service } = setup(null);
  const base = { appId: APP, platform: 'jd' as const };
  expect(
    await service.getActivePid({ ...base, pidScene: 'fallback', purpose: 'convert' }),
  ).toBeNull();
  expect(await service.getActivePid({ ...base, pidScene: 'query', purpose: 'convert' })).toBeNull();
  expect(
    await service.getActivePid({ ...base, pidScene: 'self_buy', purpose: 'query' }),
  ).toBeNull();
  expect(
    await service.isWhitelisted({
      appId: APP,
      platform: 'taobao',
      unionAccountId: PID_ID,
      siteId: null,
      pid: 'mm_1_2_3',
    }),
  ).toBe(false);
});

it('[AC-B1-19b-UNIT#5] 服务对象没有删除能力', () => {
  const { service } = setup(null);
  expect(Object.keys(service).sort()).toEqual([
    'confirmHjyIgnore',
    'getActivePid',
    'isWhitelisted',
    'registerAccount',
    'registerPid',
    'setPidStatus',
  ]);
});
