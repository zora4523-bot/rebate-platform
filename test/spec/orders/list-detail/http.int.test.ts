import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, fixture, queries } from './kit.ts';
import { withHttp } from './http-kit.ts';

// Global setup clones a migrated template; no privileged connection is used by the query.
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

it('[AC-B1-08l#36] 真实共享查询直调与 HTTP data 相同，分享完整号任何出口都没有', async () => {
  const f = await fixture(db);
  const link = await f.link('jd:i_12345');
  const self = await f.seed();
  const share = await f.seed({ buy_type: 'share', link_id: link });
  const other = await f.seed({ buy_type: 'share', link_id: link, product_key: 'jd:i_99999' });
  const q = await queries(f.deps);
  await withHttp(q, f.subject, async (send) => {
    for (const scope of ['self', 'share'] as const) {
      const expected = await q.list(f.subject, { scope });
      const response = await send(`/v1/orders?scope=${scope}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ code: 0 });
      expect((response.json() as { data: unknown }).data).toEqual(expected);
      for (const row of scope === 'share' ? [share, other] : []) {
        expect(response.body).not.toContain(row.parent_order_id);
        expect(response.body).not.toContain(row.sub_order_id);
      }
    }
    for (const row of [self, share, other]) {
      const expected = await q.get(f.subject, row.order_id);
      const response = await send(`/v1/orders/${row.order_id}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ code: 0 });
      expect((response.json() as { data: unknown }).data).toEqual(expected);
      if (row.buy_type === 'share') {
        expect(response.body).not.toContain(row.parent_order_id);
        expect(response.body).not.toContain(row.sub_order_id);
      }
    }
  });
}, 30_000);

it('[AC-B1-08l#37] 不存在、他人、别的 App、未归因、超范围详情均 30701 且响应逐字节一致', async () => {
  const f = await fixture(db);
  f.settings.set('order.user_query_months', 12);
  const otherUser = await f.user();
  const otherAppUser = await f.user('foreign-app');
  const foreign = await f.seed({ user_id: otherUser });
  const otherApp = await f.seed({ app_id: 'foreign-app', user_id: otherAppUser });
  const pool = await f.seed({ rebate_status: 'UNATTRIBUTED' });
  const expired = await f.seed({ paid_at: at('2026-12-31T15:59:59.999Z') });
  const visible = await f.seed();
  const q = await queries(f.deps);
  await withHttp(q, f.subject, async (send) => {
    const responses = [];
    for (const id of [
      randomUUID(),
      foreign.order_id,
      otherApp.order_id,
      pool.order_id,
      expired.order_id,
    ]) {
      expect(await q.get(f.subject, id)).toBeNull();
      const response = await send(`/v1/orders/${id}`);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 30701 });
      responses.push(response.body);
    }
    expect(new Set(responses).size).toBe(1);
    // Independently prove app isolation even with the real owner's uid in the subject.
    expect(await q.get({ ...f.subject, app_id: 'foreign-app' }, visible.order_id)).toBeNull();
  });
}, 30_000);

it.each(['%bad', Buffer.from('{}').toString('base64url')])(
  '[AC-B1-08l#38] 畸形游标 %s → 20001 + data.fields',
  async (cursor) => {
    const f = await fixture(db);
    const q = await queries(f.deps);
    await withHttp(q, f.subject, async (send) => {
      const response = await send(`/v1/orders?scope=self&cursor=${encodeURIComponent(cursor)}`);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['cursor'] } });
    });
  },
  30_000,
);
