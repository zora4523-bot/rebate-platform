import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Insertable, Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture } from './db-kit.ts';
import { ago, HOUR, MINUTE } from './kit.ts';

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

it.each([
  [80, '等于外跳', { attr_at: ago(HOUR) }],
  [81, '后1毫秒', { attr_at: ago(HOUR - 1) }],
  [82, '跨平台分享单', { buy_type: 'share', platform: 'jd' }],
  [83, 'VOID作废且无来源', { rebate_status: 'VOID', source_match: 'none' }],
  [84, 'UNATTRIBUTED状态但user_id已是本人', { rebate_status: 'UNATTRIBUTED' }],
  [85, '未在列表显示的无付款时间订单', { paid_at: null }],
] satisfies [number, string, Partial<Insertable<DB['orders']>>][])(
  '[AC-B1-10h#%s] AC-S1-25② 任意新订单：%s也取消置顶',
  async (_n, _label, patch) => {
    const f = await fixture(db);
    await f.log();
    await f.seed({ attr_at: ago(HOUR + 1) });
    await f.seed({ attr_at: ago(30 * MINUTE), ...patch });
    const q = await f.queries();
    const page = await q.list(f.subject, { scope: 'self', platform: 'taobao', q: 'missing' });
    expect(page).toMatchObject({ items: [], claim_entry_pinned: false });
  },
);

it('[AC-B1-10h#86] AC-S1-25② 他人/他App/未归因订单不影响；外跳前1毫秒付款而后入库仍不影响', async () => {
  const f = await fixture(db);
  const other = await f.user();
  const foreign = await fixture(db);
  await f.log();
  await f.seed({ attr_at: ago(HOUR + 1), created_at: ago(1), paid_at: ago(HOUR + 1) });
  await f.seed({ attr_at: ago(1), user_id: other });
  await f.seed({ attr_at: ago(1), user_id: null, rebate_status: 'UNATTRIBUTED' });
  await foreign.seed({ attr_at: ago(1) });
  const q = await f.queries();
  const page = await q.list(f.subject, { scope: 'self' });
  expect(page.claim_entry_pinned).toBe(true);
});

it('[AC-B1-10h#87] AC-S1-25② 同一读口不缓存，新订单插入后下一次列表立即取消置顶', async () => {
  const f = await fixture(db);
  await f.log();
  const q = await f.queries();
  expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(true);
  await f.seed({ attr_at: ago(HOUR), buy_type: 'share', rebate_status: 'VOID' });
  expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(false);
});

it('[AC-B1-10h#88] AC-S1-25② 订单在更早外跳之后但最新外跳之前，不取消置顶', async () => {
  const f = await fixture(db);
  await f.log({ created_at: ago(2 * HOUR), platform: 'pdd' });
  await f.log();
  await f.seed({ attr_at: ago(90 * MINUTE) });
  const q = await f.queries();
  expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(true);
});
