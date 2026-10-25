// BR-ATTR-30（NOT_IN_POOL：子订单被管理员变更）、BR-ATTR-16：指派后该子订单其他用户的待审找回子项系统驳回，
// 与指派同一事务；claim 在全部子项已决后按 BR-ATTR-30 汇总。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assigned, fixture, open, type Harness } from './db-kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-10f#22] 指派使同子订单其他用户的待审找回子项 rejected NOT_IN_POOL（系统处理人为空）；已决子项与其他子订单的子项不动', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const target = await f.user();
  const a = await f.claim();
  const lose = await f.item(a, o);
  const b = await f.claim({ user_id: await f.user() });
  const alsoLose = await f.item(b, o);
  const c = await f.claim({ user_id: await f.user() });
  const pendingHere = await f.item(c, o);
  const unrelated = await f.item(c, await f.order());
  const d = await f.claim({ user_id: await f.user(), status: 'rejected' });
  const old = await f.item(d, o, {
    decision: 'rejected',
    reject_reason: 'OTHER',
    decided_at: f.clock.now(),
    row_version: 9,
  });

  assigned(await f.assign(o, { user_id: target }));
  const s = await f.state();
  for (const i of [lose, alsoLose, pendingHere]) {
    expect(s.items.find((r) => r.id === i.id)).toMatchObject({
      decision: 'rejected',
      reject_reason: 'NOT_IN_POOL',
      decided_by: null,
      decided_at: f.clock.now(),
      row_version: i.row_version + 1,
    });
  }
  expect(s.items.find((r) => r.id === old.id)).toEqual(old);
  expect(s.items.find((r) => r.id === unrelated.id)).toEqual(unrelated);
  // BR-ATTR-30: a claim is summarised only once all its items are decided.
  expect(s.claims.find((r) => r.id === a.id)?.status).toBe('rejected');
  expect(s.claims.find((r) => r.id === b.id)?.status).toBe('rejected');
  expect(s.claims.find((r) => r.id === c.id)?.status).toBe('manual_review');
  expect(s.claims.find((r) => r.id === d.id)?.status).toBe('rejected');
});

it('[AC-B1-10f#23] 指派被拒（期望不符）时他人待审找回子项保持待审', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const c = await f.claim({ user_id: await f.user() });
  const pending = await f.item(c, o);
  expect((await f.assign(o, { expected_locked: true })).code).toBe(20902);
  const s = await f.state();
  expect(s.items).toEqual([pending]);
  expect(s.claims).toEqual([c]);
});
