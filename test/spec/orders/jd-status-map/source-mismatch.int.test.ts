import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OrderPipelineDeps } from '../../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import { isOrderSourceMismatch } from '../../../../apps/api/src/modules/orders/domain/jd-status.ts';
import { fixture, pipeline, snapshot } from '../attribution/kit.ts';
import {
  expectSourceMismatch,
  jdFixture,
  sourceMismatchCalls,
  warnFields,
} from './pipeline-kit.ts';

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

it('[AC-B1-04zg#14] 京东 14 照常入库为 INVALID，额外一条 order_source_mismatch', async () => {
  const f = await jdFixture(db, { raw_status: '14' });
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.orders).toEqual([
    expect.objectContaining({
      platform: 'jd',
      sub_order_id: f.incoming.sub_order_id,
      platform_status: 'INVALID',
      user_id: f.userId,
    }),
  ]);
  expect(s.pending).toEqual([]);
  expect(f.onImported).toHaveBeenCalledTimes(1);
  expectSourceMismatch(f, '14');
});

it('[AC-B1-04zg#15] 京东 40 照常走表外码：待处理不建单，额外一条 order_source_mismatch', async () => {
  const f = await jdFixture(db, { raw_status: '40' });
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toEqual({
    kind: 'pending',
    reason: 'UNMAPPED_STATUS',
  });
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.keys).toEqual([]);
  expect(s.orders).toEqual([]);
  expect(s.pending).toEqual([
    expect.objectContaining({
      platform: 'jd',
      sub_order_id: f.incoming.sub_order_id,
      order_id: null,
      reason: 'UNMAPPED_STATUS',
      raw_status: '40',
      status: 'open',
    }),
  ]);
  expect(warnFields(f.logger, 'UNMAPPED_STATUS')).toEqual([
    { platform: 'jd', app_id: f.ctx.app_id, reason: 'UNMAPPED_STATUS', outcome: 'pending' },
  ]);
  expect(f.onImported).not.toHaveBeenCalled();
  expectSourceMismatch(f, '40');
});

it.each(['14', '40'])(
  '[AC-B1-04zg#16] 京东 %s 推广位不在本 App：照记 PID_NOT_OURS 丢弃，告警照写',
  async (rawStatus) => {
    const f = await jdFixture(db, { raw_status: rawStatus });
    f.findPid.mockResolvedValue([]);
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toEqual({ kind: 'dropped', reason: 'PID_NOT_OURS' });
    const s = await snapshot(db, f.ctx.app_id);
    expect(s.orders).toEqual([]);
    expect(s.pending).toEqual([]);
    expect(s.drops).toEqual([
      expect.objectContaining({ platform: 'jd', reason: 'PID_NOT_OURS', count: 1n }),
    ]);
    expectSourceMismatch(f, rawStatus);
  },
);

it.each(['14', '40'])(
  '[AC-B1-04zg#17] 京东已入库的单变成 %s：照常交 updateStep，告警照写',
  async (rawStatus) => {
    const f = await jdFixture(db);
    const apply = vi
      .fn<NonNullable<OrderPipelineDeps['updateStep']>['apply']>()
      .mockResolvedValue({ kind: 'updated' });
    const p = await pipeline({ ...f.deps, updateStep: { apply } });
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
    expect(sourceMismatchCalls(f.logger)).toEqual([]);
    const changed = { ...f.incoming, raw_status: rawStatus };
    expect(await p.process(changed, f.ctx)).toEqual({ kind: 'updated' });
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ sub_order_id: f.incoming.sub_order_id }),
      changed,
      f.ctx,
    );
    expectSourceMismatch(f, rawStatus);
  },
);

it('[AC-B1-04zg#18] 京东 14 重放（content_hash 未变）零写入，每处理一行写一条', async () => {
  const f = await jdFixture(db, { raw_status: '14' });
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const before = await snapshot(db, f.ctx.app_id);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'unchanged' });
  expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
  const fields = {
    platform: 'jd',
    app_id: f.ctx.app_id,
    raw_status: '14',
    event: 'order_source_mismatch',
  };
  expect(sourceMismatchCalls(f.logger).map((call) => call[0])).toEqual([fields, fields]);
});

it.each([
  ['jd', '16'],
  ['jd', '41'],
  ['pdd', '14'],
  ['pdd', '40'],
  ['taobao', '14'],
  ['taobao', '40'],
] as const)('[AC-B1-04zg#19] %s 的 %s 不写 order_source_mismatch', async (platform, rawStatus) => {
  // 骨架上先红：判定函数与流水线同口径，流水线今天本来就不写这条。
  expect(isOrderSourceMismatch(platform, rawStatus)).toBe(false);
  const f = await fixture(db, { platform, raw_status: rawStatus });
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'pending' });
  expect(sourceMismatchCalls(f.logger)).toEqual([]);
});

it('[AC-B1-04zg#20] 告警全文不含订单号、父单号、用户参数', async () => {
  const f = await jdFixture(db, { raw_status: '14' });
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const calls = sourceMismatchCalls(f.logger);
  expect(calls).toHaveLength(1);
  const text = JSON.stringify(calls);
  expect(text).not.toContain(f.incoming.sub_order_id);
  expect(text).not.toContain(f.incoming.order_id);
  expect(text).not.toContain(f.incoming.parent_order_id);
  expect(text).not.toContain('abcd1234');
});
