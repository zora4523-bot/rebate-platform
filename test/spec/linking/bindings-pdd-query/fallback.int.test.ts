import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { conflict, newAccount } from '../relation-conflict/records.ts';
import { fixture, listed, noSideEffects, snapshot, TIMEOUT } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['active', 'blocked'] as const)(
  '[AC-B1-06x#3] %s 原样返回，不查联盟、不改绑定或冲突',
  async (status) => {
    const f = await fixture(database(), status);
    await conflict(
      f.db,
      { appId: f.appId, userId: f.a.userId, platform: 'pdd', accountId: f.accountId },
      f.clock.now(),
    );
    await f.expire();
    const before = await snapshot(f);
    await listed(await f.list(), status);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(await snapshot(f)).toEqual(before);
    await noSideEffects(f);
  },
  TIMEOUT,
);

it.each(['absent', 'unbound', 'pending_auth', 'invalid', 'released'] as const)(
  '[AC-B1-06x#4] %s 查询未授权：200 库内投影，不发 state、不写会话或日志',
  async (status) => {
    const f = await fixture(database(), status);
    f.query.mockResolvedValue({ authorized: false });
    await conflict(
      f.db,
      { appId: f.appId, userId: f.a.userId, platform: 'pdd', accountId: f.accountId },
      f.clock.now(),
    );
    const before = await snapshot(f);
    await listed(await f.list(), status === 'absent' ? 'unbound' : status);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(await snapshot(f)).toEqual(before);
    await noSideEffects(f);
  },
  TIMEOUT,
);

it.each([
  'throws',
  'missing',
  'null',
  'empty',
  'string_boolean',
  'expired',
  'no_pid',
  'pid_throws',
  'no_attr',
  'bad_attr',
  'attr_throws',
] as const)(
  '[AC-B1-06x#5] %s：查询或前置资料不可用，仍 200 且不写库',
  async (failure) => {
    const f = await fixture(database());
    switch (failure) {
      case 'throws':
        f.query.mockRejectedValue(new Error('synthetic query timeout'));
        break;
      case 'missing':
        delete f.adapter.queryPddAuthority;
        break;
      case 'null':
      case 'empty':
      case 'string_boolean': {
        const malformed: unknown =
          failure === 'null' ? null : failure === 'empty' ? {} : { authorized: 'true' };
        f.query.mockResolvedValue(malformed as { authorized: boolean });
        break;
      }
      case 'expired': {
        await f.expire();
        f.clock.advanceMs(1_000);
        // A different usable account must not conceal the bound account's expiry.
        await newAccount(f.db, f.appId, 'pdd', f.clock.now());
        break;
      }
      case 'no_pid':
        f.getActivePid.mockResolvedValue(null);
        break;
      case 'pid_throws':
        f.getActivePid.mockRejectedValue(new Error('synthetic pid failure'));
        break;
      case 'no_attr':
        f.attrCode.mockResolvedValue(null);
        break;
      case 'bad_attr':
        f.attrCode.mockResolvedValue(f.a.userId);
        break;
      case 'attr_throws':
        f.attrCode.mockRejectedValue(new Error('synthetic attr failure'));
        break;
    }
    const before = await snapshot(f);
    await listed(await f.list(), 'invalid');
    expect(await snapshot(f)).toEqual(before);
    const called = ['throws', 'null', 'empty', 'string_boolean'].includes(failure);
    expect(f.query).toHaveBeenCalledTimes(called ? 1 : 0);
    await noSideEffects(f);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06x#6] 未登录先返回 10001，不查询或写库',
  async () => {
    const f = await fixture(database());
    f.current.mockResolvedValue({ appId: f.appId, userId: null, deviceId: f.a.deviceId });
    const before = await snapshot(f);
    expect(await f.list()).toMatchObject({ status: 401, envelope: { code: 10001 } });
    expect(f.query).not.toHaveBeenCalled();
    expect(await snapshot(f)).toEqual(before);
  },
  TIMEOUT,
);
