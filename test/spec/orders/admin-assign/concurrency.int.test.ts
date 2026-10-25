// BR-ATTR-31 细则「并发冲突例」：同一子订单的两次指派在子订单锁上排队，后到者锁内重读到 user_id 非空 → 20902。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, open, reassignedEvents, type Harness } from './db-kit.ts';
import { CONFLICT } from './kit.ts';

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

it('[AC-B1-10f#20] 两个管理员同时把同一未归因子订单指派给不同用户：只有一个成功，另一个 20902，只落一次指派', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const second = await f.admin();
  const targets = [await f.user(), await f.user()];
  const admins = [f.adminId, second];
  const results = await Promise.all(
    targets.map((target, i) =>
      f.assign(o, { user_id: target }, { actor: { adminId: admins[i]! } }),
    ),
  );
  expect(results.map((r) => r.code).sort()).toEqual([0, 20902]);
  const won = results.findIndex((r) => r.code === 0);
  expect(results[1 - won]).toEqual(CONFLICT);
  const s = await f.state();
  expect(s.orders[0]).toMatchObject({ user_id: targets[won], user_basis: 'admin', locked: true });
  expect(s.assignments).toHaveLength(1);
  expect(s.assignments[0]).toMatchObject({ to_user_id: targets[won], admin_id: admins[won] });
  expect(f.rebate.onAdminAssigned).toHaveBeenCalledTimes(1);
  expect(f.snapshots.create).toHaveBeenCalledTimes(1);
  expect(s.history).toHaveLength(1);
  expect(s.audits).toHaveLength(1);
  expect(s.audits[0]?.admin_id).toBe(admins[won]);
  expect(reassignedEvents(s)).toHaveLength(1);
  expect(s.jobs).toHaveLength(1);
}, 20_000);

it('[AC-B1-10f#21] 同一请求重复并发提交（同管理员、同目标）：一次成功，其余 20902，没有第二条指派、审计或事件', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const results = await Promise.all([f.assign(o), f.assign(o), f.assign(o)]);
  expect(results.map((r) => r.code).sort()).toEqual([0, 20902, 20902]);
  for (const r of results.filter((x) => x.code !== 0)) expect(r).toEqual(CONFLICT);
  const s = await f.state();
  expect(s.assignments).toHaveLength(1);
  expect(s.audits).toHaveLength(1);
  expect(reassignedEvents(s)).toHaveLength(1);
  expect(f.rebate.onAdminAssigned).toHaveBeenCalledTimes(1);
}, 20_000);
