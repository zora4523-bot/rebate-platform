import { expect, it, vi } from 'vitest';
import {
  addLink,
  addRef,
  failAudit,
  linkOf,
  member,
  newPoolId,
  otherApp,
  PERMISSION,
  pick,
  product,
  rejected,
  seedItem,
  seedPool,
  send,
  setup,
  snapshot,
  stableId,
  stubProduct,
  success,
  useHarness,
  type Operation,
  type Pool,
  type Setup,
  type Target,
} from './kit.ts';
import { AdminOperationGuardImpl } from '../../../../apps/api/src/modules/admin/application/admin-operation-guard.ts';

const h = useHarness();

const KEY = 'tb:Access';
interface Case {
  op: Operation;
  target: (pool: string) => Target;
  body?: () => Record<string, unknown>;
  query?: string;
}
const bounds = { sort: 0, start_at: null, end_at: null };
const CASES: readonly Case[] = [
  { op: 'listPools', target: () => ({}) },
  { op: 'getPool', target: (pool) => ({ pool }) },
  { op: 'listItems', target: (pool) => ({ pool }) },
  { op: 'candidates', target: () => ({}), query: '?platform=taobao&q=abc' },
  { op: 'createPool', target: () => ({}), body: () => ({ pool_id: newPoolId(), name: '新池' }) },
  {
    op: 'updatePool',
    target: (pool) => ({ pool }),
    body: () => ({ name: '新名字', expected_revision: 0 }),
  },
  {
    op: 'addItem',
    target: (pool) => ({ pool }),
    body: () => ({ link_text: linkOf('rawA-Access'), ...bounds }),
  },
  { op: 'updateItem', target: (pool) => ({ pool, key: KEY }), body: () => ({ sort: 1 }) },
  { op: 'removeItem', target: (pool) => ({ pool, key: KEY }) },
];
const READS: readonly Operation[] = ['listPools', 'getPool', 'listItems', 'candidates'];

async function poolWithItem(f: Setup) {
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, KEY);
  return pool;
}
const call = (f: Setup, one: Case, pool: string, token?: string | null) =>
  send(f, one.op, one.target(pool), one.body?.(), {
    ...(one.query === undefined ? {} : { query: one.query }),
    ...(token === undefined ? {} : { token }),
  });

it.each(CASES)('[AC-B1-05q#100] $op 未登录 → 10001，不写入', async (one) => {
  const f = await setup(h);
  const pool = await poolWithItem(f);
  const before = await snapshot(h, f.appId);
  await rejected(await call(f, one, pool, null), 10001);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each(CASES)(
  '[AC-B1-05q#101] $op 要求 content.pool，其他 content 权限不能替代 → 10403，不写入',
  async (one) => {
    const f = await setup(h);
    const pool = await poolWithItem(f);
    const denied = await member(h, f, ['content.page', 'content.article']);
    const before = await snapshot(h, f.appId);
    await rejected(await call(f, one, pool, denied.token), 10403, {
      reason: 'admin_permission_denied',
    });
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it.each(CASES)('[AC-B1-05q#102] $op 守卫用 content.pool，读操作 readOnly', async (one) => {
  const f = await setup(h);
  const pool = await poolWithItem(f);
  const guard = vi.spyOn(AdminOperationGuardImpl.prototype, 'run');
  try {
    guard.mockClear();
    await call(f, one, pool);
    expect(guard).toHaveBeenCalled();
    const input = guard.mock.lastCall![0];
    expect(input).toMatchObject({ permission: PERMISSION });
    expect(input.readOnly === true).toBe(READS.includes(one.op));
  } finally {
    guard.mockRestore();
  }
});

it('[AC-B1-05q#103] 读操作不写审计', async () => {
  const f = await setup(h);
  const pool = await poolWithItem(f);
  await success(await send(f, 'listPools'));
  await success(await send(f, 'getPool', { pool }));
  await success(await send(f, 'listItems', { pool }));
  expect((await snapshot(h, f.appId)).audits).toEqual([]);
});

it('[AC-B1-05q#104] 别的 App 管理员碰不到这个池：改池、入库、条目读写都是 30701，两边都不写入', async () => {
  const f = await setup(h);
  const pool = await poolWithItem(f);
  const other = await otherApp(h, f);
  const item = product(f, stableId());
  const { item_ref: ref } = await pick(other, item);
  stubProduct(item);
  const before = await snapshot(h, f.appId);
  const callerBefore = await snapshot(h, other.appId);
  await rejected(await send(other, 'listItems', { pool }), 30701);
  await rejected(
    await send(other, 'updatePool', { pool }, { name: '越权改名', expected_revision: 0 }),
    30701,
  );
  await rejected(await addLink(other, pool, linkOf(item.item_id!)), 30701);
  await rejected(await addRef(other, pool, ref), 30701);
  await rejected(await send(other, 'updateItem', { pool, key: KEY }, { sort: 1 }), 30701);
  await rejected(await send(other, 'removeItem', { pool, key: KEY }), 30701);
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await snapshot(h, other.appId)).toEqual(callerBefore);
});

it('[AC-B1-05q#106] 两个 App 持有同一个 pool_id 和 key：写操作只动调用方自己的', async () => {
  const f = await setup(h);
  const other = await otherApp(h, f);
  const pool = await poolWithItem(f);
  await seedPool(h, other, { pool_id: pool });
  await seedItem(h, other, pool, KEY);
  const stable = stableId();
  const key = `tb:${stable}`;
  await seedItem(h, f, pool, key);
  const item = product(f, stable);
  stubProduct(item);
  f.clock.advanceMs(1000);
  const before = await snapshot(h, f.appId);
  const name = '乙 App 的新名字';
  expect(
    await success<Pool>(await send(other, 'updatePool', { pool }, { name, expected_revision: 0 })),
  ).toMatchObject({ name, revision: 1 });
  expect(await success(await addLink(other, pool, linkOf(item.item_id!)))).toMatchObject({
    product_key: key,
    status: 'online',
    created_by: other.actor.id,
  });
  const moved = await success(await send(other, 'updateItem', { pool, key: KEY }, { sort: 7 }));
  expect(moved).toMatchObject({ sort: 7 });
  await success(await send(other, 'removeItem', { pool, key: KEY }));
  expect(await snapshot(h, f.appId)).toEqual(before);
  const state = await snapshot(h, other.appId);
  expect(state.pools.map((row) => row.name)).toEqual([name]);
  expect(state.items.map((row) => row.product_key)).toEqual([key]);
});

const WRITES = CASES.filter((one) => !READS.includes(one.op));

it.each(WRITES)('[AC-B1-05q#105] $op 审计写失败整笔回滚，池、条目和审计都不留', async (one) => {
  const f = await setup(h);
  const pool = await poolWithItem(f);
  stubProduct(product(f, stableId()));
  failAudit(f.appId);
  const { pools, items, audits } = await snapshot(h, f.appId);
  await rejected(await call(f, one, pool), 50001);
  expect(await snapshot(h, f.appId)).toMatchObject({ pools, items, audits });
});
