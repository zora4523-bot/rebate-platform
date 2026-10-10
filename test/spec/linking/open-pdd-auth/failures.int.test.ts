import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { databaseFixture } from './database.ts';
import { fixture, outcome, service } from './kit.ts';
import { noAuthEntry, noConversion, response } from './assertions.ts';

const database = databaseFixture(createTestDatabase);

it.each([false, true])(
  '[AC-B1-06v#10] blocked 且未封禁先回 30153，账号 expired=%s 不改变优先级',
  async (expired) => {
    const f = await fixture(database(), { binding: 'blocked', query: true });
    if (expired) await f.expire();
    const before = await f.bindings();
    const open = service(f);
    const result = await response(await outcome(() => open.open(f.request())), 30153, 422);
    noAuthEntry(result);
    expect(await f.sessions()).toEqual([]);
    expect(await f.bindings()).toEqual(before);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    await noConversion(f);
  },
  60_000,
);

it.each(['timeout', 'quota_exceeded', 'adapter_unimplemented', 'missing'] as const)(
  '[AC-B1-06v#11] 查询 %s 回 50303，逐列保留绑定，不签发授权会话',
  async (failure) => {
    const query =
      failure === 'missing'
        ? 'missing'
        : failure === 'adapter_unimplemented'
          ? new UnionError(failure, 'synthetic unavailable', 'pdd')
          : new GovernanceError(failure, 'synthetic-query', 'synthetic failure');
    const f = await fixture(database(), { binding: 'invalid', query });
    const before = await f.bindings();
    const open = service(f);
    const result = await response(await outcome(() => open.open(f.request())), 50303, 503);
    noAuthEntry(result);
    expect(await f.bindings()).toEqual(before);
    expect(await f.sessions()).toEqual([]);
    expect(f.query).toHaveBeenCalledTimes(failure === 'missing' ? 0 : 1);
    expect(f.fetch).not.toHaveBeenCalled();
    await noConversion(f);
    expect(await f.logs()).toEqual([expect.objectContaining({ result_code: 50303 })]);
  },
  60_000,
);

it.each(['absent', 'unbound', 'active'] as const)(
  '[AC-B1-06v#12] %s 所用账号过期返回 maintenance，其他 active 账号不能掩盖',
  async (binding) => {
    const f = await fixture(database(), { binding, query: true });
    await f.expire();
    await f.account('active');
    const before = await f.bindings();
    const open = service(f);
    const result = await response(await outcome(() => open.open(f.request())), 50301, 503);
    expect(result.envelope.data).toEqual({ reason: 'maintenance' });
    noAuthEntry(result);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.sessions()).toEqual([]);
    expect(await f.bindings()).toEqual(before);
    await noConversion(f);
  },
  60_000,
);

it('[AC-B1-06v#13] 未释放绑定账号优先于 active pid 账号：按实际所用账号判 maintenance', async () => {
  const f = await fixture(database(), { binding: 'invalid', query: true });
  const other = await f.account('active');
  await f.expire();
  const original = f.getActivePid.getMockImplementation()!;
  f.getActivePid.mockImplementation(async (q) => ({
    ...(await original(q)),
    union_account_id: other,
  }));
  const open = service(f);
  const result = await response(await outcome(() => open.open(f.request())), 50301, 503);
  expect(result.envelope.data).toEqual({ reason: 'maintenance' });
  expect(f.query).not.toHaveBeenCalled();
  expect(await f.sessions()).toEqual([]);
  await noConversion(f);
}, 60_000);

it('[AC-B1-06v#14] 转链开关关闭先拒绝，不进行授权查询或授权会话写入', async () => {
  const f = await fixture(database(), { binding: 'absent', query: false });
  f.config.set('convert.enabled.pdd', false);
  const open = service(f);
  await response(await outcome(() => open.open(f.request())), 50301, 503);
  expect(f.query).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(await f.sessions()).toEqual([]);
  expect(await f.bindings()).toEqual([]);
  await noConversion(f);
}, 60_000);
