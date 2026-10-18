import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, expected } from './db-kit.ts';
import { at } from './kit.ts';

// Global setup injects the template factory connection; each file clones it.
// All fixture writes and application queries use the ordinary application role.
let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-S1-55#6] 已上报 L1 不被迟到但未外跳的 L2 顶替，L1 完成也不回退', async () => {
  const f = await fixture(db);
  const l1 = await f.link({ platform: 'taobao' });
  const l2 = await f.link({ platform: 'taobao' });
  const a1 = await f.open(0, { link_id: l1 });
  await f.report(a1.attempt_id, 1);
  await f.open(10, { link_id: l2 });
  const { q } = await f.service();
  f.clock.set(at(20));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a1, 'taobao')] });
  await f.complete(l1, 40);
  f.clock.set(at(45));
  expect(await q.list(f.subject)).toEqual({ items: [] });
});

it('[AC-S1-55#7] a1/a2 已上报，a3 取消无上报：跟随 a2 的 open 时钟', async () => {
  const f = await fixture(db);
  const a1 = await f.open(0);
  await f.report(a1.attempt_id, 1);
  const a2 = await f.open(5);
  await f.report(a2.attempt_id, 6);
  await f.open(10, { link_id: a1.link_id });
  const { q } = await f.service();
  f.clock.set(at(12));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a2)] });
  f.clock.set(at(16));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a2)] });
  f.clock.set(at(20));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a2)] });
  f.clock.set(at(35));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a2, 'jd', true)] });
  // 重发上报与冒用令牌的采信由埋点后续任务覆盖，本任务不提供写入口。
});

it('[AC-S1-55#8] 旧订单不完成新尝试，迟到关闭只关旧尝试，后续订单完成新尝试', async () => {
  const f = await fixture(db);
  const a1 = await f.open(0);
  await f.report(a1.attempt_id, 1);
  const { q } = await f.service();
  await f.complete(a1.link_id, 20);
  f.clock.set(at(21));
  expect(await q.list(f.subject)).toEqual({ items: [] });
  const a2 = await f.open(30, { link_id: a1.link_id });
  await f.report(a2.attempt_id, 31);
  f.clock.set(at(32));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a2)] });
  f.clock.set(at(33));
  await q.dismiss(f.subject, a1.link_id, a1.attempt_id);
  expect(await q.list(f.subject)).toEqual({ items: [expected(a2)] });
  const saved = await f.saved();
  expect(saved.find((r) => r.attempt_id === a1.attempt_id)?.dismissed_at).toEqual(at(33));
  expect(saved.find((r) => r.attempt_id === a2.attempt_id)?.dismissed_at).toBeNull();
  f.clock.set(at(61));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a2, 'jd', true)] });
  await f.complete(a2.link_id, 70);
  f.clock.set(at(71));
  expect(await q.list(f.subject)).toEqual({ items: [] });
  // 用独立的未完成尝试验证寿命边界。
  const a3 = await f.open(80);
  f.clock.set(at(80 + 72 * 60));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a3, 'jd', true)] });
  f.clock.advanceMs(60_000);
  expect(await q.list(f.subject)).toEqual({ items: [] });
});

it('[AC-S1-55#9] 无上报选较晚；补报进入第一档但按 open 时间排序', async () => {
  const f = await fixture(db);
  const a1 = await f.open(0);
  const a2 = await f.open(5);
  const { q } = await f.service();
  f.clock.set(at(10));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a2)] });
  await f.report(a1.attempt_id, 11);
  f.clock.set(at(12));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a1)] });
  const a3 = await f.open(15);
  const a4 = await f.open(20);
  await f.report(a4.attempt_id, 21);
  f.clock.set(at(22));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a4)] });
  await f.report(a3.attempt_id, 23);
  f.clock.set(at(24));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a4)] });
});

it('[AC-S1-55#10] a2 上报丢失不顶替 a1；全丢时第二档仍在 30 分钟出入口', async () => {
  const f = await fixture(db);
  const a1 = await f.open(0);
  await f.report(a1.attempt_id, 1);
  await f.open(5);
  const l2 = await f.link({ platform: 'pdd' });
  const a3 = await f.open(10, { link_id: l2 });
  const { q } = await f.service();
  f.clock.set(at(39, 59_000));
  expect(await q.list(f.subject)).toEqual({
    items: [expected(a1, 'jd', true), expected(a3, 'pdd')],
  });
  f.clock.set(at(40));
  expect(await q.list(f.subject)).toEqual({
    items: [expected(a1, 'jd', true), expected(a3, 'pdd', true)],
  });
});
