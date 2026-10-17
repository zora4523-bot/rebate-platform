import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OrderPipelineDeps } from '../../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import { at, ATTR, fixture, pipeline, snapshot } from './kit.ts';

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

it('[AC-B1-08h#43] hash 相同或只换 raw_payload_id 零写入，不碰 updated_at、不重查归属', async () => {
  const f = await fixture(db);
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const before = await snapshot(db, f.ctx.app_id);
  f.clock.advanceMs(86_400_000);
  f.findPid.mockClear();
  f.findUser.mockClear();
  f.findBindings.mockClear();
  f.syncStartAt.mockClear();
  f.onImported.mockClear();
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'unchanged' });
  expect(await p.process({ ...f.incoming, raw_payload_id: '202' }, f.ctx)).toMatchObject({
    kind: 'unchanged',
  });
  expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
  expect(f.findPid).not.toHaveBeenCalled();
  expect(f.findUser).not.toHaveBeenCalled();
  expect(f.findBindings).not.toHaveBeenCalled();
  expect(f.syncStartAt).not.toHaveBeenCalled();
  expect(f.onImported).not.toHaveBeenCalled();
});

it('[AC-B1-08h#44] hash 变化却没有 updateStep 必须报 NotImplemented，订单保持原样', async () => {
  const f = await fixture(db);
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const before = await snapshot(db, f.ctx.app_id);
  await expect(p.process({ ...f.incoming, est_commission_fen: 790n }, f.ctx)).rejects.toThrow(
    /NotImplemented/,
  );
  expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
  expect(f.onImported).toHaveBeenCalledTimes(1);
});

it('[AC-B1-08h#45] hash 变化交 updateStep，保留首次 attr_at 和用户及推广参数', async () => {
  const f = await fixture(db);
  const apply = vi
    .fn<NonNullable<OrderPipelineDeps['updateStep']>['apply']>()
    .mockResolvedValue({ kind: 'unchanged' });
  const p = await pipeline({ ...f.deps, updateStep: { apply } });
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const before = await snapshot(db, f.ctx.app_id);
  const changed = {
    ...f.incoming,
    deposit_paid_at: at('2026-10-14T02:03:04.000Z'),
    paid_at: at('2026-10-17T03:04:05.000Z'),
    promotion_slot: 'foreign-slot',
    attr_params: {
      relation_id: 'new-relation',
      sub_union_id: 'n_zzzz9999',
      custom_parameters: 'changed',
    },
  };
  f.findPid.mockClear();
  f.findUser.mockClear();
  expect(await p.process(changed, f.ctx)).toEqual({ kind: 'unchanged' });
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({
      order_id: before.orders[0]!.order_id,
      attr_at: at(ATTR),
      user_id: f.userId,
      pid: 'slot-ours',
      custom_params: f.incoming.attr_params!.custom_parameters,
    }),
    changed,
    f.ctx,
  );
  expect(apply.mock.calls[0]?.[0].isTransaction).toBe(true);
  expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
  expect(f.findPid).not.toHaveBeenCalled();
  expect(f.findUser).not.toHaveBeenCalled();
  expect(f.onImported).toHaveBeenCalledTimes(1);
});

it('[AC-B1-08h#46] 全局 order_keys 已属其他 App，零写入并 P1 告警，不先匹配推广位', async () => {
  const f = await fixture(db);
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const before = await snapshot(db, f.ctx.app_id);
  const foreignApp = `${f.ctx.app_id}-other`;
  const otherBefore = await snapshot(db, foreignApp);
  f.findPid.mockClear();
  f.findUser.mockClear();
  expect(
    await p.process(
      { ...f.incoming, promotion_slot: 'foreign', raw_status: 'outside-map' },
      { ...f.ctx, app_id: foreignApp },
    ),
  ).toMatchObject({ kind: 'app_conflict' });
  expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
  expect(await snapshot(db, foreignApp)).toEqual(otherBefore);
  expect(f.findPid).not.toHaveBeenCalled();
  expect(f.findUser).not.toHaveBeenCalled();
  expect(f.logger.error).toHaveBeenCalled();
  expect(f.onImported).toHaveBeenCalledTimes(1);
});

it.each([true, false, undefined])(
  '[AC-B1-08h#47] mtimeOrdering=%s：只有开启时旧 mtime 才丢弃',
  async (enabled) => {
    const f = await fixture(db);
    const apply = vi
      .fn<NonNullable<OrderPipelineDeps['updateStep']>['apply']>()
      .mockResolvedValue({ kind: 'unchanged' });
    const deps = {
      ...f.deps,
      updateStep: { apply },
      ...(enabled === undefined ? {} : { mtimeOrdering: vi.fn(() => enabled) }),
    };
    const p = await pipeline(deps);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
    const before = await snapshot(db, f.ctx.app_id);
    const stale = {
      ...f.incoming,
      modified_at: at('2026-10-16T08:09:09.999Z'),
      est_commission_fen: 999n,
    };
    expect(await p.process(stale, f.ctx)).toMatchObject({ kind: enabled ? 'stale' : 'unchanged' });
    expect(apply).toHaveBeenCalledTimes(enabled ? 0 : 1);
    if (!enabled) expect(apply.mock.calls[0]?.[2]).toEqual(stale);
    expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
  },
);

it('[AC-B1-08h#48] 开启排序时相等 mtime 不丢弃，hash 变化交更新端口', async () => {
  const f = await fixture(db);
  const apply = vi
    .fn<NonNullable<OrderPipelineDeps['updateStep']>['apply']>()
    .mockResolvedValue({ kind: 'unchanged' });
  const p = await pipeline({ ...f.deps, updateStep: { apply }, mtimeOrdering: () => true });
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  expect(await p.process({ ...f.incoming, est_commission_fen: 999n }, f.ctx)).toEqual({
    kind: 'unchanged',
  });
  expect(apply).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  '[AC-B1-08h#49] 无 mtime 且排序=%s，首次计数与重放 hash 短路的例外',
  async (enabled) => {
    const f = await fixture(db, { modified_at: null });
    const p = await pipeline({ ...f.deps, mtimeOrdering: () => enabled });
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
    const before = await snapshot(db, f.ctx.app_id);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'unchanged' });
    const after = await snapshot(db, f.ctx.app_id);
    expect(after.orders).toEqual(before.orders);
    expect(after.history).toEqual(before.history);
    if (enabled) {
      // The existing-order branch explicitly counts missing mtime before the hash shortcut.
      const oldCount =
        before.counters.find((r) => r.counter === 'order_sync_no_mtime')?.count ?? 0n;
      expect(after.counters).toEqual([
        expect.objectContaining({
          counter: 'order_sync_no_mtime',
          day: '2026-10-16',
          count: oldCount + 1n,
        }),
      ]);
    } else expect(after.counters).toEqual([]);
  },
);

it('[AC-B1-08h#50] 更新端口失败连同 no_mtime 计数回滚，不影响已提交的另一子订单', async () => {
  const f = await fixture(db);
  const apply = vi
    .fn<NonNullable<OrderPipelineDeps['updateStep']>['apply']>()
    .mockRejectedValue(new Error('synthetic update failure'));
  const p = await pipeline({ ...f.deps, updateStep: { apply }, mtimeOrdering: () => true });
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  expect(
    await p.process({ ...f.incoming, sub_order_id: `${f.incoming.sub_order_id}-other` }, f.ctx),
  ).toMatchObject({ kind: 'inserted' });
  const before = await snapshot(db, f.ctx.app_id);
  await expect(p.process({ ...f.incoming, modified_at: null }, f.ctx)).rejects.toThrow(
    'synthetic update failure',
  );
  expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
});
