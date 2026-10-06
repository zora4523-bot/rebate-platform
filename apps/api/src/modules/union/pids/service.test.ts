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

it('[AC-B1-19b-UNIT#6] 推广位与 site_id 含空白或控制字符一律拒绝（不改写），淘宝 pid 格式与 site_id 一致性在校验动态码之前检查', async () => {
  const { service, verify } = setup({ appId: APP, adminId: ADMIN });
  const base = { ...ctx, unionAccountId: PID_ID, pidScene: 'self_buy' as const };
  const cases = [
    { ...base, platform: 'jd' as const, siteId: null, pid: '12345\n' },
    { ...base, platform: 'jd' as const, siteId: null, pid: ' 12345' },
    { ...base, platform: 'pdd' as const, siteId: null, pid: '100_2\t3' },
    { ...base, platform: 'jd' as const, siteId: null, pid: '' },
    { ...base, platform: 'taobao' as const, siteId: '2', pid: 'mm_1_2_3 ' },
    { ...base, platform: 'taobao' as const, siteId: ' 2', pid: 'mm_1_2_3' },
    { ...base, platform: 'taobao' as const, siteId: '999', pid: 'mm_1_2_3' },
    { ...base, platform: 'taobao' as const, siteId: '2', pid: 'mm_1_2' },
    { ...base, platform: 'taobao' as const, siteId: '2', pid: 'mm_a_2_3' },
    { ...base, platform: 'taobao' as const, siteId: '2', pid: '1_2_3' },
  ];
  for (const input of cases) {
    await expect(service.registerPid(input)).rejects.toMatchObject({ code: 'invalid_input' });
  }
  expect(verify).not.toHaveBeenCalled();
});

it('[AC-B1-19b-UNIT#7] 白名单查询的推广位或 site_id 含空白时拒绝，不查库', async () => {
  const { service } = setup(null);
  const key = { appId: APP, unionAccountId: PID_ID };
  for (const input of [
    { ...key, platform: 'jd' as const, siteId: null, pid: '12345\n' },
    { ...key, platform: 'taobao' as const, siteId: '2 ', pid: 'mm_1_2_3' },
    { ...key, platform: 'taobao' as const, siteId: '2', pid: ' mm_1_2_3' },
  ]) {
    await expect(service.isWhitelisted(input)).rejects.toMatchObject({ code: 'invalid_input' });
  }
});

it('[AC-B1-19b-UNIT#8] 幂等键格式不对时在校验动态码之前拒绝', async () => {
  const { service, verify } = setup({ appId: APP, adminId: ADMIN });
  for (const idempotencyKey of ['', 'short', 'has space key', 'x'.repeat(65), 'bad*chars!']) {
    await expect(
      service.setPidStatus({ ...ctx, idempotencyKey, pidId: PID_ID, status: 'active' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  }
  expect(verify).not.toHaveBeenCalled();
});

it('[AC-B1-19b-UNIT#9] 幂等层回答「同键不同请求」「同键进行中」时报错，不写库；请求范围不含动态码与 IP', async () => {
  const verify = vi.fn<PidServiceDeps['superVerifier']['verify']>(async () => ({
    appId: APP,
    adminId: ADMIN.toUpperCase(),
  }));
  const append = vi.fn(async () => undefined);
  const responses = [
    { code: 20901, expected: 'idempotency_conflict' },
    { code: 40901, expected: 'idempotency_in_progress' },
  ];
  for (const { code, expected } of responses) {
    const executeInTransaction = vi.fn<
      NonNullable<PidServiceDeps['idempotency']>['executeInTransaction']
    >(async () => ({
      status: 409,
      body: JSON.stringify({ code, msg: 'x', trace_id: 't' }),
      source: 'idempotency' as const,
    }));
    const service = createUnionPidService({
      db: untouchableDb(),
      clock: { now: () => new Date('2031-01-01T00:00:00Z') },
      superVerifier: { verify },
      auditWriter: () => ({ append }),
      idempotency: { executeInTransaction },
    });
    await expect(
      service.setPidStatus({
        ...ctx,
        idempotencyKey: 'retry-key-0001',
        pidId: PID_ID,
        status: 'retired',
      }),
    ).rejects.toMatchObject({ code: expected });
    const request = executeInTransaction.mock.calls[0]![0];
    expect(request).toMatchObject({
      appId: APP,
      actor: { userId: null, deviceId: ADMIN, phoneHmac: null },
      method: 'POST',
      path: `/admin/v1/union-pids/${PID_ID}/status`,
      key: 'retry-key-0001',
      body: { status: 'retired' },
    });
    expect(JSON.stringify(request)).not.toContain('123456');
  }
  expect(append).not.toHaveBeenCalled();
});
