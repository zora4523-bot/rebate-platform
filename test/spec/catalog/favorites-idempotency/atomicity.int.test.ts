// B1-28e §B.1–3. No additional BR scope: the oracle is the task's transaction/replay contract.
// Faults occur after real favorites SQL. PG decides rollback/commit, never an in-memory model.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseFixture } from './db-kit.ts';
import { laterTime, outcome, userId } from './kit.ts';

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase();
}, 60_000);
afterAll(async () => {
  await database.drop();
}, 60_000);

it('[AC-B1-28e#4] 加入后 completed 写失败：收藏与记录一起回滚，同事务持有用户锁，同键可立即重试', async () => {
  const f = databaseFixture(database, 'fav-atomic-add', 'completed-write');
  try {
    const error = await outcome(() => f.call('add'));
    expect(f.state.snapshot).toEqual({
      inside: ['tb:favorite001'],
      outside: [],
      visibleRecords: [],
      userLocks: 1,
    });
    expect(error).toBe('injected favorites completed-write failure');
    expect(f.state.completionFailures).toBe(1);
    expect(await f.favorites()).toEqual([]);
    expect(await f.records()).toEqual([]);

    f.state.fault = 'none';
    const first = await f.call('add');
    expect(first).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{"platform":"taobao","product_key":"tb:favorite001","favorited_at":"2031-05-20T04:00:00.000Z"},"trace_id":"original-trace"}',
    });
    expect((await f.favorites()).map((row) => row.product_key)).toEqual(['tb:favorite001']);
    expect(await f.records()).toEqual([{ status: 'completed' }]);
    f.clock.set(laterTime);
    const replay = await f.call('add', 'later-trace');
    expect(replay.body).toBe(
      '{"code":0,"msg":"","data":{"platform":"taobao","product_key":"tb:favorite001","favorited_at":"2031-05-20T04:00:00.000Z"},"trace_id":"original-trace"}',
    );
    // One rolled-back INSERT, one committed INSERT; replay performs no third write.
    expect(f.state.favoriteWrites).toBe(2);
    expect((await f.favorites()).map((row) => row.created_at.toISOString())).toEqual([
      '2031-05-20T04:00:00.000Z',
    ]);
    // The new transaction entry must retain the old cap/original-record semantics too.
    f.state.cap = 1;
    expect(
      await f.call('add', 'at-cap', {
        headers: { 'idempotency-key': 'existing-at-cap', 'x-channel': 'appstore' },
      }),
    ).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{"platform":"taobao","product_key":"tb:favorite001","favorited_at":"2031-05-20T04:00:00.000Z"},"trace_id":"at-cap"}',
    });
    f.state.cap = 2;
    expect(
      await f.call('add', 'reach-cap', {
        headers: { 'idempotency-key': 'fill-last-slot', 'x-channel': 'appstore' },
        params: { platform: 'taobao', product_key: 'tb:favorite002' },
      }),
    ).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{"platform":"taobao","product_key":"tb:favorite002","favorited_at":"2031-05-20T04:02:00.000Z"},"trace_id":"reach-cap"}',
    });
    expect((await f.favorites()).map((row) => row.product_key)).toEqual([
      'tb:favorite001',
      'tb:favorite002',
    ]);
    expect(await f.records('fill-last-slot')).toEqual([{ status: 'completed' }]);
    const full = await f.call('add', 'full-trace', {
      headers: { 'idempotency-key': 'new-at-cap', 'x-channel': 'appstore' },
      params: { platform: 'taobao', product_key: 'tb:favorite003' },
    });
    expect(full.status).toBe(400);
    expect(JSON.parse(full.body)).toMatchObject({
      code: 20001,
      data: { reason: 'favorites_full' },
    });
    expect(await f.records('new-at-cap')).toEqual([]);
    expect((await f.favorites()).map((row) => row.product_key)).toEqual([
      'tb:favorite001',
      'tb:favorite002',
    ]);
  } finally {
    await f.close();
  }
}, 30_000);

it('[AC-B1-28e#5] 取消后 completed 写失败：原行恢复，另一端加入仍返回原行，首次成功后重放不删新收藏', async () => {
  const f = databaseFixture(database, 'fav-atomic-remove', 'completed-write');
  try {
    await f.seed('tb:favorite001', '01920000-0000-7000-8000-000000000101');
    const error = await outcome(() => f.call('remove'));
    expect(f.state.snapshot).toEqual({
      inside: [],
      outside: ['tb:favorite001'],
      visibleRecords: [],
      userLocks: 1,
    });
    expect(error).toBe('injected favorites completed-write failure');
    expect((await f.favorites()).map((row) => row.id)).toEqual([
      '01920000-0000-7000-8000-000000000101',
    ]);
    expect(await f.records()).toEqual([]);

    f.state.fault = 'none';
    f.clock.set(laterTime);
    const existing = await f.otherEnd.addFavorite(
      'fav-atomic-remove',
      userId,
      'taobao',
      'tb:favorite001',
    );
    // A rolled-back delete never removed this row. An intervening add is a no-op, not a new
    // generation; the original delete key is still unused and its first successful retry deletes it.
    expect(existing.id).toBe('01920000-0000-7000-8000-000000000101');
    expect(existing.favoritedAt.toISOString()).toBe('2031-05-20T04:00:00.000Z');
    expect(await f.call('remove')).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{},"trace_id":"original-trace"}',
    });
    expect(await f.favorites()).toEqual([]);
    expect(await f.records()).toEqual([{ status: 'completed' }]);

    await f.seed('tb:favorite001', '01920000-0000-7000-8000-000000000201');
    expect(await f.call('remove', 'later-trace')).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{},"trace_id":"original-trace"}',
    });
    expect((await f.favorites()).map((row) => row.id)).toEqual([
      '01920000-0000-7000-8000-000000000201',
    ]);
    expect(f.state.favoriteWrites).toBe(2);
    expect(
      await f.call('remove', 'absent-trace', {
        headers: { 'idempotency-key': 'remove-absent', 'x-channel': 'appstore' },
        params: { platform: 'taobao', product_key: 'tb:favorite003' },
      }),
    ).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{},"trace_id":"absent-trace"}',
    });
    expect(await f.records('remove-absent')).toEqual([{ status: 'completed' }]);
    expect(
      (await f.favorites()).map((row) => ({
        id: row.id,
        key: row.product_key,
        at: row.created_at.toISOString(),
      })),
    ).toEqual([
      {
        id: '01920000-0000-7000-8000-000000000201',
        key: 'tb:favorite001',
        at: '2031-05-20T04:00:00.000Z',
      },
    ]);
  } finally {
    await f.close();
  }
}, 30_000);

it('[AC-B1-28e#6] 批量删除后 completed 写失败：整批恢复，同键首次成功删除后重放保留重新加入的两行', async () => {
  const f = databaseFixture(database, 'fav-atomic-batch', 'completed-write');
  try {
    await f.seed('tb:favorite001', '01920000-0000-7000-8000-000000000101');
    await f.seed('tb:favorite002', '01920000-0000-7000-8000-000000000102');
    const error = await outcome(() => f.call('batchDelete'));
    expect(f.state.snapshot).toEqual({
      inside: [],
      outside: ['tb:favorite001', 'tb:favorite002'],
      visibleRecords: [],
      userLocks: 1,
    });
    expect(error).toBe('injected favorites completed-write failure');
    expect((await f.favorites()).map((row) => row.id)).toEqual([
      '01920000-0000-7000-8000-000000000101',
      '01920000-0000-7000-8000-000000000102',
    ]);
    expect(await f.records()).toEqual([]);

    f.state.fault = 'none';
    expect(await f.call('batchDelete')).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{},"trace_id":"original-trace"}',
    });
    expect(await f.favorites()).toEqual([]);
    expect(await f.records()).toEqual([{ status: 'completed' }]);
    await f.seed('tb:favorite001', '01920000-0000-7000-8000-000000000301');
    await f.seed('tb:favorite002', '01920000-0000-7000-8000-000000000302');
    f.clock.set(laterTime);
    expect(await f.call('batchDelete', 'later-trace')).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{},"trace_id":"original-trace"}',
    });
    expect((await f.favorites()).map((row) => row.id)).toEqual([
      '01920000-0000-7000-8000-000000000301',
      '01920000-0000-7000-8000-000000000302',
    ]);
    const tooMany = await f.call('batchDelete', 'batch-limit', {
      headers: { 'idempotency-key': 'batch-over-limit', 'x-channel': 'appstore' },
      body: {
        items: Array.from({ length: 101 }, () => ({
          platform: 'taobao',
          product_key: 'tb:favorite001',
        })),
      },
    });
    expect(tooMany.status).toBe(400);
    expect(JSON.parse(tooMany.body)).toMatchObject({ code: 20001, data: { fields: ['items'] } });
    expect(await f.records('batch-over-limit')).toEqual([]);
    expect((await f.favorites()).map((row) => row.id)).toEqual([
      '01920000-0000-7000-8000-000000000301',
      '01920000-0000-7000-8000-000000000302',
    ]);
    expect(
      await f.call('batchDelete', 'batch-boundary', {
        headers: { 'idempotency-key': 'batch-at-limit', 'x-channel': 'appstore' },
        body: {
          items: [
            { platform: 'taobao', product_key: 'tb:favorite001' },
            { platform: 'taobao', product_key: 'tb:favorite002' },
            ...Array.from({ length: 98 }, (_, index) => ({
              platform: 'taobao',
              product_key: `tb:absent${index}`,
            })),
          ],
        },
      }),
    ).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{},"trace_id":"batch-boundary"}',
    });
    expect(await f.favorites()).toEqual([]);
    expect(await f.records('batch-at-limit')).toEqual([{ status: 'completed' }]);
  } finally {
    await f.close();
  }
}, 30_000);

it('[AC-B1-28e#7] 加入提交成功但确认丢失：另一端取消后，同键重放不能重新插入收藏', async () => {
  const f = databaseFixture(database, 'fav-lost-add', 'commit-ack');
  try {
    const error = await outcome(() => f.call('add'));
    expect(f.state.lostCommits).toBe(1);
    expect(await f.records()).toEqual([{ status: 'completed' }]);
    expect(error).toBe('the transaction outcome is unknown');
    expect((await f.favorites()).map((row) => row.product_key)).toEqual(['tb:favorite001']);
    await f.otherEnd.removeFavorite('fav-lost-add', userId, 'taobao', 'tb:favorite001');
    f.clock.set(laterTime); // Beyond the old 60 s processing lease.
    expect(await f.call('add', 'after-restart')).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{"platform":"taobao","product_key":"tb:favorite001","favorited_at":"2031-05-20T04:00:00.000Z"},"trace_id":"original-trace"}',
    });
    expect(await f.favorites()).toEqual([]);
    expect(f.state.favoriteWrites).toBe(1);
  } finally {
    await f.close();
  }
}, 30_000);

it('[AC-B1-28e#8] 取消提交成功但确认丢失：另一端重新加入，过租约同键重放保留新行', async () => {
  const f = databaseFixture(database, 'fav-lost-remove', 'commit-ack');
  try {
    await f.seed('tb:favorite001', '01920000-0000-7000-8000-000000000101');
    const error = await outcome(() => f.call('remove'));
    expect(f.state.lostCommits).toBe(1);
    expect(await f.records()).toEqual([{ status: 'completed' }]);
    expect(error).toBe('the transaction outcome is unknown');
    expect(await f.favorites()).toEqual([]);
    f.clock.set(laterTime);
    await f.otherEnd.addFavorite('fav-lost-remove', userId, 'taobao', 'tb:favorite001');
    expect(await f.call('remove', 'after-restart')).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{},"trace_id":"original-trace"}',
    });
    expect(
      (await f.favorites()).map((row) => ({
        key: row.product_key,
        at: row.created_at.toISOString(),
      })),
    ).toEqual([{ key: 'tb:favorite001', at: '2031-05-20T04:02:00.000Z' }]);
    expect(f.state.favoriteWrites).toBe(1);
  } finally {
    await f.close();
  }
}, 30_000);

it('[AC-B1-28e#9] 批量删除提交成功但确认丢失：重新加入的整批收藏不能被原键再删', async () => {
  const f = databaseFixture(database, 'fav-lost-batch', 'commit-ack');
  try {
    await f.seed('tb:favorite001', '01920000-0000-7000-8000-000000000101');
    await f.seed('tb:favorite002', '01920000-0000-7000-8000-000000000102');
    const error = await outcome(() => f.call('batchDelete'));
    expect(f.state.lostCommits).toBe(1);
    expect(await f.records()).toEqual([{ status: 'completed' }]);
    expect(error).toBe('the transaction outcome is unknown');
    expect(await f.favorites()).toEqual([]);
    f.clock.set(laterTime);
    await f.otherEnd.addFavorite('fav-lost-batch', userId, 'taobao', 'tb:favorite001');
    await f.otherEnd.addFavorite('fav-lost-batch', userId, 'taobao', 'tb:favorite002');
    expect(await f.call('batchDelete', 'after-restart')).toEqual({
      status: 200,
      body: '{"code":0,"msg":"","data":{},"trace_id":"original-trace"}',
    });
    expect(
      (await f.favorites()).map((row) => ({
        key: row.product_key,
        at: row.created_at.toISOString(),
      })),
    ).toEqual([
      { key: 'tb:favorite001', at: '2031-05-20T04:02:00.000Z' },
      { key: 'tb:favorite002', at: '2031-05-20T04:02:00.000Z' },
    ]);
    expect(await f.records()).toEqual([{ status: 'completed' }]);
  } finally {
    await f.close();
  }
}, 30_000);
