import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  databaseFixture,
  fixture,
  order,
  settlement,
  snapshot,
  state,
  NOW,
  RUN,
  MONTH,
  TIMEOUT,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04n#1] 当日快照未完成则推迟，不锁死幂等键；完成后原任务可生成',
  async () => {
    const h = fixture(database.db);
    await order(h);
    await snapshot(h, '2032-07-22');
    const other = fixture(database.db);
    await snapshot(other);
    const result = await h.run();
    expect(result).toMatchObject({ outcome: 'deferred', billId: MONTH, status: null });
    expect(h.snapshotStatus).toHaveBeenCalledWith(
      expect.anything(),
      { appId: h.appId, accountingDate: '2032-07-23' },
      h.clock,
    );
    expect(h.readSource).not.toHaveBeenCalled();
    expect(await state(h)).toMatchObject({
      bills: [],
      batches: [],
      items: [],
      jobs: [],
      diffs: [],
      validations: [],
    });
    await snapshot(h);
    expect(await h.run()).toMatchObject({ outcome: 'generated', billId: MONTH, status: '已出账' });
    expect((await state(h)).jobs).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#2] 已完成但 waiting_comparable=false 的快照仍允许生成',
  async () => {
    const h = fixture(database.db);
    await snapshot(h, '2032-07-23', false);
    await settlement(h, await order(h));
    expect(await h.run()).toMatchObject({ outcome: 'generated', status: '已出账' });
    const s = await state(h);
    expect(s.batches).toHaveLength(1);
    expect(s.bills[0]).toMatchObject({
      bill_id: MONTH,
      generation_started_at: new Date(NOW),
      generated_at: new Date(NOW),
    });
    expect(s.jobs[0]).toMatchObject({
      job: 'bill',
      status: 'done',
      run_at: new Date(RUN),
      started_at: new Date(NOW),
      finished_at: new Date(NOW),
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#3] 北京时间 00:30 前等待，恰到超时可生成且不伪造资产快照',
  async () => {
    const h = fixture(database.db);
    await settlement(h, await order(h));
    h.clock.set('2032-07-24T00:29:59.999+08:00');
    expect((await h.run()).outcome).toBe('deferred');
    h.clock.advanceMs(1);
    expect((await h.run()).outcome).toBe('generated');
    expect((await state(h)).batches).toHaveLength(1);
    expect(
      await h.db.selectFrom('asset_snapshots').selectAll().where('app_id', '=', h.appId).execute(),
    ).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#4] 延迟到次月补跑仍用名义账单月，等待的是实际执行日的快照',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    h.clock.set('2032-08-01T00:10:00+08:00');
    await settlement(h, await order(h));
    expect(await h.run()).toMatchObject({ outcome: 'deferred', billId: MONTH });
    expect(h.snapshotStatus).toHaveBeenLastCalledWith(
      expect.anything(),
      { appId: h.appId, accountingDate: '2032-07-31' },
      h.clock,
    );
    await snapshot(h, '2032-07-31');
    expect(await h.run()).toMatchObject({ outcome: 'generated', billId: MONTH });
    expect((await state(h)).bills[0]).toMatchObject({
      bill_id: MONTH,
      generation_started_at: h.clock.now(),
    });
    expect(h.readSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appId: h.appId,
        platform: 'taobao',
        billId: MONTH,
        runAt: new Date(RUN),
        generationStartedAt: h.clock.now(),
      }),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#5] 默认每月 24 日，非账单日没有出账副作用',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    expect(await h.run('taobao', new Date('2032-07-23T23:59:59+08:00'))).toMatchObject({
      outcome: 'not_due',
    });
    expect(await state(h)).toMatchObject({ bills: [], batches: [], jobs: [], validations: [] });
    expect(h.readSource).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it.each([22, 28])(
  '[AC-B2-04n#6] 配置账单日 %i 按北京时间生效，跨年账单月取上一年十二月',
  async (day) => {
    const h = fixture(database.db);
    h.values.set('settle.bill_day', day);
    const runAt = new Date(`2033-01-${String(day)}T00:01:00+08:00`);
    h.clock.set(`2033-01-${String(day)}T00:30:00+08:00`);
    expect(await h.run('taobao', runAt)).toMatchObject({
      outcome: 'generated',
      billId: '2032-12',
      status: '已出账',
    });
    expect((await state(h)).bills.map((b) => b.bill_id)).toEqual(['2032-12']);
  },
  TIMEOUT,
);
