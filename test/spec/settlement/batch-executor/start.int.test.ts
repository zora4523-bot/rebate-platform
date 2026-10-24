// B2-04p rule tests on a real PostgreSQL: where a batch_execute delivery may start a batch (SB5)
// and where it must end without writing anything. BR-FUND-04 细则「结算批次迁移表」SB5 与
// 「到执行时刻开关为 off 与执行中跨日」②; BR-FUND-18 (no batch before the day's asset snapshot is
// complete or timed out, 00:30); 规划/12 §4.3.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  NOW,
  TIMEOUT,
  creditedOnce,
  databaseFixture,
  fixture,
  p0Orders,
  untouched,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04p#1] SB5→SB6：立即结算的 CONFIRMED 批次（两个开关开、当日快照已超时）开始执行：写 started_at，逐单入账后 DONE 并写 finished_at，不写 settle_jobs',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'sb5', 2);
    const b = await f.batch(orders);
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    const row = await f.stored(b);
    expect(row).toMatchObject({
      status: 'DONE',
      started_at: new Date(NOW),
      finished_at: new Date(NOW),
      paused_by_switch_at: null,
    });
    expect(row.row_version).toBeGreaterThan(3);
    for (const o of orders) {
      await creditedOnce(f, o);
      expect(await f.itemOf(b, o)).toMatchObject({
        result: 'credited',
        skip_reason: null,
        amount_fen: null,
      });
    }
    // batch_execute 的进度只在批次与明细里（规划/04 §3.2 settle_jobs 行）。
    expect(await f.settleJobs()).toBe(0);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#2] SB5「已到执行时刻」：定时结算未到 scheduled_at 时 not_due，什么都不写；到点后再投递才开始，started_at 为到点时刻',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'sched', 1);
    const at = '2032-07-24T11:00:00+08:00';
    const b = await f.batch(orders, { settle_mode: 'SCHEDULED', scheduled_at: new Date(at) });
    const before = await f.snapshot();
    expect(await f.run(b)).toMatchObject({ outcome: 'not_due' });
    expect(await f.snapshot()).toEqual(before);
    expect(f.creditCalls).toHaveLength(0);

    f.clock.set(at);
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    expect(await f.stored(b)).toMatchObject({ status: 'DONE', started_at: new Date(at) });
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it.each([
  ['settle.auto.enabled', false],
  ['settle.auto.enabled', 'off'],
  ['credit.enabled.taobao', false],
  ['credit.enabled.taobao', 'off'],
  // credit.enabled.<platform> 默认 off（BR-CALC-03）：没有配置值也不执行。
  ['credit.enabled.taobao', undefined],
] as const)(
  '[AC-B2-04p#3] 到执行时刻 %s=%s：不执行，批次保持 CONFIRMED 并写停住标记 paused_by_switch_at；开关恢复后再投递仍不自动开始（只能走 SB10）',
  async (key, value) => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'off', 2);
    const b = await f.batch(orders);
    f.switches.set(key, value);

    expect(await f.run(b)).toMatchObject({ outcome: 'switched_off' });
    const row = await f.stored(b);
    expect(row).toMatchObject({
      status: 'CONFIRMED',
      paused_by_switch_at: new Date(NOW),
      started_at: null,
      finished_at: null,
    });
    // 停住标记也按 row_version CAS 写。
    expect(row.row_version).toBeGreaterThan(3);
    for (const o of orders) {
      await untouched(f, o);
      expect((await f.itemOf(b, o)).result).toBeNull();
    }
    expect(f.creditCalls).toHaveLength(0);

    // 开关恢复、快照也已超时：带停住标记的批次不由 SB5 开始。
    f.switches.set('settle.auto.enabled', true);
    f.switches.set('credit.enabled.taobao', true);
    f.clock.advanceMs(60_000);
    const before = await f.snapshot();
    expect(await f.run(b)).toMatchObject({ outcome: 'idle' });
    expect(await f.snapshot()).toEqual(before);
    expect(f.creditCalls).toHaveLength(0);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#4] 停住标记先于快照判断写入：00:10 当日快照未完成也未超时、credit.enabled 为 off → 写标记、不执行；快照完成后也不自动开始',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'offsnap', 1);
    const b = await f.batch(orders, { confirmed_at: new Date('2032-07-23T23:00:00+08:00') });
    f.clock.set('2032-07-24T00:10:00+08:00');
    f.switches.set('credit.enabled.taobao', false);

    expect(await f.run(b)).toMatchObject({ outcome: 'switched_off' });
    expect(await f.stored(b)).toMatchObject({
      status: 'CONFIRMED',
      paused_by_switch_at: new Date('2032-07-24T00:10:00+08:00'),
      started_at: null,
    });

    f.switches.set('credit.enabled.taobao', true);
    await f.snapshotDone('2032-07-23');
    expect(await f.run(b)).toMatchObject({ outcome: 'idle' });
    expect((await f.stored(b)).status).toBe('CONFIRMED');
    for (const o of orders) await untouched(f, o);
    expect(f.creditCalls).toHaveLength(0);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#5] 已带停住标记的 CONFIRMED 批次：开关都开、快照已超时也不开始，不写任何东西',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'marked', 1);
    const b = await f.batch(orders, {
      paused_by_switch_at: new Date('2032-07-24T09:30:00+08:00'),
    });
    const before = await f.snapshot();
    expect(await f.run(b)).toMatchObject({ outcome: 'idle' });
    expect(await f.snapshot()).toEqual(before);
    expect(f.creditCalls).toHaveLength(0);
  },
  TIMEOUT,
);

it.each(['complete', 'timed_out'] as const)(
  '[AC-B2-04p#6] BR-FUND-18：00:10 当日快照未完成也未超时 → snapshot_pending，批次与明细不变、不写停住标记；快照 %s 后再投递才执行',
  async (how) => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'snap', 2);
    const b = await f.batch(orders, { confirmed_at: new Date('2032-07-23T23:00:00+08:00') });
    f.clock.set('2032-07-24T00:10:00+08:00');

    const before = await f.snapshot();
    expect(await f.run(b)).toMatchObject({ outcome: 'snapshot_pending' });
    expect(await f.snapshot()).toEqual(before);
    expect(f.creditCalls).toHaveLength(0);

    if (how === 'complete') await f.snapshotDone('2032-07-23');
    else f.clock.set('2032-07-24T00:30:00+08:00');
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    expect(await f.stored(b)).toMatchObject({ status: 'DONE', paused_by_switch_at: null });
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it.each(['DRAFT', 'PARTIAL', 'DONE', 'CANCELLED'] as const)(
  '[AC-B2-04p#7] 批次为 %s 时执行任务幂等结束（PARTIAL 不自动续跑）：idle，不调用入账，批次、明细、订单与账务都不变',
  async (status) => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, `idle-${status.toLowerCase()}`, 1);
    const b = await f.batch(orders, { status });
    const before = await f.snapshot();
    expect(await f.run(b)).toMatchObject({ outcome: 'idle' });
    expect(await f.snapshot()).toEqual(before);
    expect(f.creditCalls).toHaveLength(0);
    expect(f.beneficiaryCalls).toHaveLength(0);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#8] 只执行本 app 的批次：用别的 app_id 投递同一 batch_id → idle，该批次与订单都不变',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'app', 1);
    const b = await f.batch(orders);
    const before = await f.snapshot();
    const other = await f.executor().run({ appId: `other-${randomUUID()}`, batchId: b.batchId });
    expect(other).toMatchObject({ outcome: 'idle' });
    expect(await f.snapshot()).toEqual(before);
    expect(f.creditCalls).toHaveLength(0);
  },
  TIMEOUT,
);
