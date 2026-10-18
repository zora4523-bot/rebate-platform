import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, expected } from './db-kit.ts';
import { at } from './kit.ts';
import { randomUUID } from 'node:crypto';
import { withHttp } from './http-kit.ts';

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

it('[AC-B1-08m#23] 关闭只写尝试且时间取 Clock；重复 HTTP 200 不改任何列', async () => {
  const f = await fixture(db);
  const a = await f.open(0);
  const another = await f.open(5, { link_id: a.link_id });
  f.clock.set(at(20));
  const { q, dismiss } = await f.service();
  const links = await db.selectFrom('links').selectAll().execute();
  const logs = await db.selectFrom('link_logs').selectAll().execute();
  const orders = await db.selectFrom('orders').selectAll().execute();
  await withHttp(
    q,
    f.subject,
    async (send) => {
      const path = `/v1/orders/pending-tracks/${a.link_id}/dismiss`;
      const first = await send(path, { attempt_id: a.attempt_id });
      expect(first.statusCode).toBe(200);
      expect(dismiss).toHaveBeenCalledWith({
        ...f.subject,
        link_id: a.link_id,
        attempt_id: a.attempt_id,
        at: at(20),
      });
      const saved = await f.saved();
      expect(saved.find((r) => r.attempt_id === a.attempt_id)).toMatchObject({
        dismissed_at: at(20),
        updated_at: at(20),
        row_version: 1,
      });
      expect(saved.find((r) => r.attempt_id === another.attempt_id)).toMatchObject({
        dismissed_at: null,
        row_version: 0,
      });
      f.clock.advanceMs(60_000);
      expect((await send(path, { attempt_id: a.attempt_id })).statusCode).toBe(200);
      expect(await f.saved()).toEqual(saved);
      expect(await db.selectFrom('links').selectAll().execute()).toEqual(links);
      expect(await db.selectFrom('link_logs').selectAll().execute()).toEqual(logs);
      expect(await db.selectFrom('orders').selectAll().execute()).toEqual(orders);
      expect(await q.list(f.subject)).toEqual({ items: [expected(another)] });
    },
    undefined,
    f.clock,
  );
}, 30_000);

it.each(['他人', '别App', '别link', '未知link', '不存在', '非UUID'])(
  '[AC-B1-08m#24] %s 的关闭 HTTP 400 / 20001 fields=[attempt_id]，数据库零变化',
  async (kind) => {
    const f = await fixture(db);
    const a = await f.open(0);
    const foreign = await fixture(db);
    const alien = await foreign.open(2);
    const otherUser = await f.user();
    const otherLink = await f.link({ user_id: otherUser });
    const other = await f.open(4, { user_id: otherUser, link_id: otherLink });
    const secondLink = await f.link();
    const target = kind === '别App' ? alien : kind === '他人' ? other : a;
    const linkId =
      kind === '别link' ? secondLink : kind === '未知link' ? randomUUID() : target.link_id;
    const attemptId =
      kind === '不存在' ? randomUUID() : kind === '非UUID' ? 'not-a-uuid' : target.attempt_id;
    f.clock.set(at(20));
    const { q } = await f.service();
    const before = await f.saved();
    const links = await db.selectFrom('links').selectAll().execute();
    const logs = await db.selectFrom('link_logs').selectAll().execute();
    const orders = await db.selectFrom('orders').selectAll().execute();
    await withHttp(
      q,
      f.subject,
      async (send) => {
        const result = await send(`/v1/orders/pending-tracks/${linkId}/dismiss`, {
          attempt_id: attemptId,
        });
        expect(result.statusCode).toBe(400);
        expect(result.json()).toMatchObject({ code: 20001, data: { fields: ['attempt_id'] } });
        expect(await f.saved()).toEqual(before);
        expect(await db.selectFrom('links').selectAll().execute()).toEqual(links);
        expect(await db.selectFrom('link_logs').selectAll().execute()).toEqual(logs);
        expect(await db.selectFrom('orders').selectAll().execute()).toEqual(orders);
      },
      undefined,
      f.clock,
    );
  },
  30_000,
);

it('[AC-B1-08m#25] 超过 72 小时仍可关闭，并发重复关闭只增加一次版本', async () => {
  const f = await fixture(db);
  const a = await f.open(0);
  f.clock.set(at(72 * 60 + 1));
  const { q } = await f.service();
  expect(await q.list(f.subject)).toEqual({ items: [] });
  await Promise.all([
    q.dismiss(f.subject, a.link_id, a.attempt_id),
    q.dismiss(f.subject, a.link_id, a.attempt_id),
  ]);
  expect((await f.saved()).find((r) => r.attempt_id === a.attempt_id)).toMatchObject({
    dismissed_at: f.clock.now(),
    updated_at: f.clock.now(),
    row_version: 1,
  });
});

it('[AC-B1-08m#34] linking 关闭端口自身隔离 App/用户/link，已关闭也不得跨主体当作幂等成功', async () => {
  const f = await fixture(db);
  const a = await f.open(0);
  const { attempts } = await f.service();
  const input = { ...f.subject, link_id: a.link_id, attempt_id: a.attempt_id, at: at(10) };
  expect(await attempts.dismiss(input)).toBe(true);
  const saved = await f.saved();
  for (const patch of [
    { app_id: 'other-app' },
    { user_id: randomUUID() },
    { link_id: randomUUID() },
    { attempt_id: randomUUID() },
    { attempt_id: 'not-a-uuid' },
  ])
    expect(await attempts.dismiss({ ...input, ...patch, at: at(20) })).toBe(false);
  expect(await f.saved()).toEqual(saved);
});
