import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createOrderQueries,
  type OrderFilter,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { createClaimEntryReader } from '../../../../apps/api/src/modules/linking/index.ts';
import { fixture } from './db-kit.ts';
import { ago, capture, HOUR, MINUTE, value } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-10h#90] AC-S1-25② 每页每种筛选同值，scope=share缺省，旧无端口调用保持原结果', async () => {
  const f = await fixture(db);
  await f.log();
  for (let i = 0; i < 3; i++) await f.seed();
  const q = await f.queries();
  const first = await q.list(f.subject, { scope: 'self', limit: 1 });
  expect(first.claim_entry_pinned).toBe(true);
  expect(first.next_cursor).toEqual(expect.any(String));
  const filters: OrderFilter[] = [
    { scope: 'self', cursor: first.next_cursor!, limit: 1 },
    { scope: 'self', platform: 'pdd' },
    { scope: 'self', status_group: 'credited' },
    { scope: 'self', display_status: 'INVALID' },
    { scope: 'self', q: 'no matching product' },
    { scope: 'self', paid_month: '2026-01' },
    {
      scope: 'self',
      cursor: first.next_cursor!,
      platform: 'taobao',
      q: 'missing',
      paid_month: '2026-01',
    },
  ];
  for (const filter of filters)
    expect((await q.list(f.subject, filter)).claim_entry_pinned).toBe(true);
  expect(await q.list(f.subject, { scope: 'share' })).not.toHaveProperty('claim_entry_pinned');
  // Frozen B1-08l dependencies have no reader: compare their original response, no new-field assertion.
  const legacy = await value(() => createOrderQueries(f.deps));
  expect(await legacy.list(f.subject, { scope: 'self', platform: 'pdd' })).toEqual({
    items: [],
    next_cursor: null,
    earliest_visible_date: null,
  });
  await f.seed({ attr_at: ago(HOUR), buy_type: 'share' });
  for (const filter of filters)
    expect((await q.list(f.subject, filter)).claim_entry_pinned).toBe(false);
});

it('[AC-B1-10h#91] AC-S1-25② 一次请求只读一次Clock，读口窗口两端固定且不缓存', async () => {
  const f = await fixture(db);
  await f.log({ created_at: ago(30 * MINUTE) });
  const reader = await value(() => createClaimEntryReader(db));
  const read = vi.fn(reader.read.bind(reader));
  let calls = 0;
  const clock = {
    now: () => {
      calls += 1;
      return ago(-(calls - 1));
    },
  };
  const q = await value(() => createOrderQueries({ ...f.deps, clock, claimEntry: { read } }));
  const first = await q.list(f.subject, { scope: 'self' });
  expect(first.claim_entry_pinned).toBe(true);
  expect(calls).toBe(1);
  expect(read).toHaveBeenCalledExactlyOnceWith({ ...f.subject, from: ago(72 * HOUR), to: ago(0) });
  await q.list(f.subject, { scope: 'self' });
  expect(calls).toBe(2);
  expect(read).toHaveBeenCalledTimes(2);
});

it('[AC-B1-10h#92] AC-S1-25② 读口错误原样冒泡，恢复后重新读取，share无需置顶读口', async () => {
  const f = await fixture(db);
  const failure = new Error('synthetic claim-entry read outage');
  let fail = true;
  const read = vi.fn(async () => {
    if (fail) throw failure;
    return { logs: [], bindings: [] };
  });
  const q = await value(() => createOrderQueries({ ...f.deps, claimEntry: { read } }));
  const outcome = await capture(() => q.list(f.subject, { scope: 'self' }));
  expect(outcome).toEqual({ ok: false, error: failure });
  fail = false;
  expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(false);
  expect(read).toHaveBeenCalledTimes(2);
  fail = true;
  const share = await q.list(f.subject, { scope: 'share' });
  expect(share).not.toHaveProperty('claim_entry_pinned');
  expect(read).toHaveBeenCalledTimes(2);
});

it('[AC-B1-10h#93] AC-S1-25② 不读找回开关或新增配置；数据库只读事务能完整返回', async () => {
  const f = await fixture(db);
  await f.log();
  f.settings.set('claims.enabled', false);
  f.config.configValue = vi.fn(async (_app, key) => {
    expect(key).toBe('order.user_query_months');
    return { value: 0, version: 1 };
  });
  const result = await db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      const claimEntry = await value(() => createClaimEntryReader(trx));
      const q = await value(() => createOrderQueries({ ...f.deps, db: trx, claimEntry }));
      return q.list(f.subject, { scope: 'self' });
    });
  expect(result.claim_entry_pinned).toBe(true);
  expect(f.config.configValue).toHaveBeenCalledWith(f.subject.app_id, 'order.user_query_months');
});

it('[AC-B1-10h#94] AC-S1-25② 时钟推进使false→true→false，同一查询实例不缓存结论', async () => {
  const f = await fixture(db);
  await f.log({ created_at: ago(30 * MINUTE - 1) });
  const q = await f.queries();
  expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(false);
  f.clock.advanceMs(1);
  expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(true);
  f.clock.advanceMs(72 * HOUR - 30 * MINUTE);
  expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(true);
  f.clock.advanceMs(1);
  expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(false);
});
