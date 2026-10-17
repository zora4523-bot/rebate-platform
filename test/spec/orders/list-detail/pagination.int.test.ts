import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, capture, fixture, ids, queries } from './kit.ts';

// Clone the global setup template, then use the non-administrative application role.
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

it('[AC-B1-08l#21] pay_time 倒序，同时间 order_id 倒序，分页不重不漏', async () => {
  const f = await fixture(db);
  const time = at('2027-12-25T01:02:03.000Z');
  const lower = await f.seed({ paid_at: time, order_id: '0199a3b4-5c6d-7000-8000-000000000001' });
  const higher = await f.seed({ paid_at: time, order_id: '0199a3b4-5c6d-7000-8000-000000000002' });
  const latest = await f.seed({ paid_at: at('2027-12-26T01:02:03.000Z') });
  const older = await f.seed({ paid_at: at('2027-12-24T01:02:03.000Z') });
  const q = await queries(f.deps);
  const first = await q.list(f.subject, { scope: 'self', limit: 2 });
  expect(ids(first)).toEqual([latest.order_id, higher.order_id]);
  expect(first.next_cursor).not.toBeNull();
  expect(JSON.parse(Buffer.from(first.next_cursor!, 'base64url').toString())).toEqual([
    time.toISOString(),
    higher.order_id,
  ]);
  const second = await q.list(f.subject, { scope: 'self', limit: 2, cursor: first.next_cursor! });
  expect(ids(second)).toEqual([lower.order_id, older.order_id]);
  if (second.next_cursor !== null) {
    expect(
      await q.list(f.subject, { scope: 'self', limit: 2, cursor: second.next_cursor }),
    ).toMatchObject({ items: [], next_cursor: null });
  }
});

it('[AC-B1-08l#22] 大量应用层过滤仍凑满页，剩余不足一页时游标 null', async () => {
  const f = await fixture(db);
  const link = await f.link('jd:i_12345');
  const expected: string[] = [];
  // Gaps exceed a small batch multiplier; both visibility and derived-state filters matter.
  for (let i = 0; i < 73; i++) {
    const visible = i % 18 === 0;
    const row = await f.seed(
      {
        buy_type: 'share',
        link_id: link,
        product_key: visible || i % 2 === 0 ? 'jd:i_12345' : 'jd:i_99999',
        title: 'paged item',
      },
      { b_est: visible ? 99n : 0n },
    );
    if (visible) expected.unshift(row.order_id);
  }
  const q = await queries(f.deps);
  const filter = { scope: 'share', q: 'paged', display_status: 'PAID', limit: 2 } as const;
  const found: string[] = [];
  let cursor: string | undefined;
  for (let pageNo = 0; pageNo < 5; pageNo++) {
    const page = await q.list(f.subject, {
      ...filter,
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(page.items).toHaveLength(pageNo < 2 ? 2 : 1);
    found.push(...ids(page));
    if (page.next_cursor === null) break;
    const decoded: unknown = JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString());
    expect(decoded).toEqual([expect.any(String), expect.any(String)]);
    cursor = page.next_cursor;
  }
  expect(found).toEqual(expected);
  const last = await q.list(f.subject, { ...filter, cursor: cursor! });
  expect(last.next_cursor).toBeNull();
});

it('[AC-B1-08l#23] 缺省 limit=20，上限50，游标内容无完整单号', async () => {
  const f = await fixture(db);
  const rows = [];
  for (let i = 0; i < 51; i++) rows.push(await f.seed({ buy_type: 'share' }));
  const q = await queries(f.deps);
  const normal = await q.list(f.subject, { scope: 'share' });
  expect(normal.items).toHaveLength(20);
  expect((await q.list(f.subject, { scope: 'share', limit: 50 })).items).toHaveLength(50);
  const serialized =
    JSON.stringify(normal) + Buffer.from(normal.next_cursor!, 'base64url').toString();
  for (const row of rows) {
    expect(serialized).not.toContain(row.parent_order_id);
    expect(serialized).not.toContain(row.sub_order_id);
  }
});

it.each([
  '%%%bad',
  Buffer.from('{}').toString('base64url'),
  Buffer.from('[]').toString('base64url'),
  Buffer.from('["not-date","not-uuid"]').toString('base64url'),
  Buffer.from('["2027-12-01T00:00:00.000Z","not-uuid"]').toString('base64url'),
  Buffer.from('["2027-12-01T00:00:00.000Z","0199a3b4-5c6d-7000-8000-000000000001",1]').toString(
    'base64url',
  ),
])('[AC-B1-08l#24] 畸形游标 %s 拒绝为 cursor 字段错误', async (cursor) => {
  const f = await fixture(db);
  const q = await queries(f.deps);
  const result = await capture(() => q.list(f.subject, { scope: 'self', cursor }));
  expect(result).toMatchObject({ ok: false, error: { fields: ['cursor'] } });
});
