import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { conflict, conflicts } from '../relation-conflict/records.ts';
import { fixture, listed, noSideEffects, TIMEOUT } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['absent', 'invalid', 'released'] as const)(
  '[AC-B1-06x#9] %s 两次 GET 查询同时返回，只有一条 active 且不外泄唯一键冲突',
  async (status) => {
    const f = await fixture(database(), status);
    await conflict(
      f.db,
      { appId: f.appId, userId: f.a.userId, platform: 'pdd', accountId: f.accountId },
      f.clock.now(),
    );
    const before = await f.bindings();
    const arrived = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<void>();
    let count = 0;
    f.query.mockImplementation(async () => {
      if (++count === 2) arrived.resolve(true);
      await release.promise;
      return { authorized: true };
    });
    const pending = [f.list(), f.list()];
    const timer = setTimeout(() => arrived.resolve(false), 5_000);
    let reached: boolean;
    try {
      reached = await Promise.race([arrived.promise, Promise.race(pending).then(() => false)]);
    } finally {
      clearTimeout(timer);
      release.resolve();
    }
    const results = await Promise.all(pending);
    expect(reached).toBe(true);
    for (const result of results) await listed(result, 'active');
    expect(f.query).toHaveBeenCalledTimes(2);
    const rows = await f.bindings();
    expect(rows.filter((r) => r.status !== 'released')).toEqual([
      expect.objectContaining({ app_id: f.appId, user_id: f.a.userId, status: 'active' }),
    ]);
    if (status === 'invalid') {
      expect(rows[0]).toMatchObject({ id: f.bindingId, row_version: 8 });
    }
    if (status === 'released') {
      expect(rows.find((r) => r.id === f.bindingId)).toEqual(before[0]);
    }
    expect(await conflicts(f.db, f.appId)).toEqual([
      expect.objectContaining({ resolution: 'bound_active', resolved_at: f.clock.now() }),
    ]);
    await noSideEffects(f);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06x#10] 查询等待期间被 blocked，已授权也不得覆盖停用或解决冲突',
  async () => {
    const f = await fixture(database());
    await conflict(
      f.db,
      { appId: f.appId, userId: f.a.userId, platform: 'pdd', accountId: f.accountId },
      f.clock.now(),
    );
    const beforeConflicts = await conflicts(f.db, f.appId);
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<void>();
    f.query.mockImplementation(async () => {
      entered.resolve(true);
      await release.promise;
      return { authorized: true };
    });
    const pending = f.list();
    const timer = setTimeout(() => entered.resolve(false), 5_000);
    let reached: boolean;
    let blocked: Awaited<ReturnType<typeof f.bindings>> = [];
    try {
      reached = await Promise.race([entered.promise, pending.then(() => false)]);
      if (reached) {
        await f.db
          .updateTable('union_bindings')
          .set({
            status: 'blocked',
            blocked_reason: 'admin_disable',
            row_version: 8,
          })
          .where('id', '=', f.bindingId!)
          .execute();
        blocked = await f.bindings();
      }
    } finally {
      clearTimeout(timer);
      release.resolve();
    }
    const result = await pending;
    expect(reached).toBe(true);
    await listed(result, 'blocked');
    expect(await f.bindings()).toEqual(blocked);
    expect(await conflicts(f.db, f.appId)).toEqual(beforeConflicts);
    await noSideEffects(f);
  },
  TIMEOUT,
);
