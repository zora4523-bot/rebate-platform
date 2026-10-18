import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, expected } from './db-kit.ts';
import { at } from './kit.ts';
import { capture } from './kit.ts';
import { createPendingTracks } from '../../../../apps/api/src/modules/orders/index.ts';

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

it('[AC-B1-08m#14] 读取限定本人和 App；他人/别 App/无 source_match 的订单不能完成', async () => {
  const f = await fixture(db);
  const other = await f.user();
  const a = await f.open(10);
  const foreign = await f.link({ user_id: other });
  await f.open(12, { user_id: other, link_id: foreign });
  const otherApp = await fixture(db);
  const otherAttempt = await otherApp.open(14);
  await f.complete(a.link_id, 15, { user_id: other });
  await otherApp.complete(otherAttempt.link_id, 16);
  await f.complete(a.link_id, 17, { source_match: 'none' });
  await f.complete(a.link_id, 18, { source_match: null });
  f.clock.set(at(20));
  const { q, listForUser, attempts } = await f.service();
  expect(await q.list(f.subject)).toEqual({ items: [expected(a)] });
  expect(listForUser).toHaveBeenCalledWith({ ...f.subject, since: at(20 - 72 * 60) });
  expect(
    await attempts.listForUser({
      ...f.subject,
      app_id: otherApp.subject.app_id,
      since: at(-72 * 60),
    }),
  ).toEqual([]);
  await f.complete(a.link_id, 19);
  expect(await q.list(f.subject)).toEqual({ items: [] });
});

it('[AC-B1-08m#15] 配置容差 0 不被默认 120 吞掉；读取用 token app', async () => {
  const f = await fixture(db);
  f.settings.set('attr.track_complete_tolerance_sec', 0);
  const a = await f.open(10);
  await f.complete(a.link_id, 9);
  f.clock.set(at(20));
  const { q } = await f.service();
  expect(await q.list(f.subject)).toEqual({ items: [expected(a)] });
  expect(f.config.configValue).toHaveBeenCalledWith(
    f.subject.app_id,
    'attr.track_complete_tolerance_sec',
  );
  await f.complete(a.link_id, 10);
  expect(await q.list(f.subject)).toEqual({ items: [] });
});

it('[AC-B1-08m#16] 无配置默认 120 秒；预售用 attr_at 定金而非尾款 paid_at', async () => {
  const f = await fixture(db);
  f.settings.delete('attr.track_complete_tolerance_sec');
  const a = await f.open(10);
  await f.complete(a.link_id, 5, { is_presale: true, deposit_paid_at: at(5), paid_at: at(19) });
  f.clock.set(at(20));
  const { q } = await f.service();
  expect(await q.list(f.subject)).toEqual({ items: [expected(a)] });
  await f.complete(a.link_id, 8);
  expect(await q.list(f.subject)).toEqual({ items: [] });
});

it('[AC-B1-08m#17] 72 小时边界读取包含等号，多 1ms 不返回；关闭项仍下发', async () => {
  const f = await fixture(db);
  const a = await f.open(0);
  const { q } = await f.service();
  f.clock.set(at(10));
  await q.dismiss(f.subject, a.link_id, a.attempt_id);
  f.clock.set(at(72 * 60));
  expect(await q.list(f.subject)).toEqual({ items: [expected(a, 'jd', true, true)] });
  f.clock.advanceMs(1);
  expect(await q.list(f.subject)).toEqual({ items: [] });
});

it('[AC-B1-08m#33] orders 查询自己限定 app_id，即使端口提供相同尝试也不能借用别 App 订单', async () => {
  const f = await fixture(db);
  const a = await f.open(10);
  await f.complete(a.link_id, 15);
  f.clock.set(at(20));
  const { attempts } = await f.service();
  const rows = await attempts.listForUser({ ...f.subject, since: at(-72 * 60) });
  // 保持库内外键有效，单独固定 linking 的输出以检查 orders 自己的 App 过滤。
  const created = await capture(() =>
    createPendingTracks({
      db,
      clock: f.clock,
      config: f.config,
      attempts: { listForUser: async () => rows, dismiss: async () => false },
    }),
  );
  expect(created).toMatchObject({ ok: true });
  if (!created.ok) throw created.error;
  expect(await created.value.list({ ...f.subject, app_id: 'other-app-scope' })).toEqual({
    items: [expected(a)],
  });
  expect(await created.value.list(f.subject)).toEqual({ items: [] });
});
