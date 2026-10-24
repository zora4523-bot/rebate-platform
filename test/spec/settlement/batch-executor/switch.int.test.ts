// B2-04p rule tests on a real PostgreSQL: the two switches during execution. BR-FUND-04 ⑦ (read
// settle.auto.enabled and credit.enabled.<platform> before every sub-order transaction, cache at
// most 10 seconds; either off → stop, PARTIAL, committed ones stay CREDITED, the rest WAITING; no
// automatic resume), SB7, SB8 (the B2-04o command) and the SB9 take-over that follows it;
// BR-FUND-20 (settle.auto.enabled).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  creditedOnce,
  databaseFixture,
  fixture,
  nth,
  p0Orders,
  untouched,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it.each(['settle.auto.enabled', 'credit.enabled.taobao'] as const)(
  '[AC-B2-04p#15] 执行中把 %s 关掉（缓存时限 10 秒已过）：在下一单前停止，批次 PARTIAL，已入账的保持、未处理的保持 WAITING；SB8 继续后从第一条未处理的明细续跑，每单只入账一次',
  async (key) => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'sb7', 4);
    const b = await f.batch(orders);
    const first = nth(orders, 0);
    const second = nth(orders, 1);
    const third = nth(orders, 2);
    const fourth = nth(orders, 3);
    // 第 2 单的事务里关开关并让时钟走过缓存时限：第 3 单开始前读到的必然是 off。
    f.onCredit(second, async () => {
      f.switches.set(key, false);
      f.clock.advanceMs(11_000);
    });
    expect(await f.run(b)).toMatchObject({ outcome: 'partial' });
    expect((await f.stored(b)).status).toBe('PARTIAL');

    await creditedOnce(f, first);
    expect((await f.itemOf(b, first)).result).toBe('credited');
    // 第 2 单：要么已提交（明细 credited），要么整单未处理；两者必须一致。
    const secondItem = await f.itemOf(b, second);
    if (secondItem.result === null) await untouched(f, second);
    else {
      expect(secondItem.result).toBe('credited');
      await creditedOnce(f, second);
    }
    for (const o of [third, fourth]) {
      await untouched(f, o);
      expect((await f.itemOf(b, o)).result).toBeNull();
    }
    expect(f.creditCalls.map((c) => c.input.orderId)).not.toContain(third.orderId);

    // 开关恢复后不自动续跑：PARTIAL 的执行任务 idle。
    f.switches.set(key, true);
    f.clock.advanceMs(11_000);
    expect(await f.run(b)).toMatchObject({ outcome: 'idle' });
    expect((await f.stored(b)).status).toBe('PARTIAL');

    await f.resume(b);
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    expect((await f.stored(b)).status).toBe('DONE');
    for (const o of orders) {
      await creditedOnce(f, o);
      expect((await f.itemOf(b, o)).result).toBe('credited');
    }
    const calls = (orderId: string) =>
      f.creditCalls.filter((c) => c.input.orderId === orderId).length;
    expect(calls(first.orderId)).toBe(1);
    expect(calls(third.orderId)).toBe(1);
    expect(calls(fourth.orderId)).toBe(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#16] 停在 EXECUTING、没有存活执行者的批次被接管时开关为 off：第一单前即停止，批次 PARTIAL，不调用入账',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'sb9off', 2);
    const b = await f.batch(orders, { status: 'EXECUTING' });
    f.switches.set('credit.enabled.taobao', false);
    expect(await f.run(b)).toMatchObject({ outcome: 'partial' });
    expect((await f.stored(b)).status).toBe('PARTIAL');
    expect(f.creditCalls).toHaveLength(0);
    for (const o of orders) {
      await untouched(f, o);
      expect((await f.itemOf(b, o)).result).toBeNull();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#17] 每单事务开始前都读两个开关（时钟每单前进 11 秒，超过 10 秒缓存时限）：settle.auto.enabled 与 credit.enabled.<批次平台> 各至少读到单数次',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'reads', 3);
    const b = await f.batch(orders);
    for (const o of orders) {
      f.onCredit(o, async () => {
        f.clock.advanceMs(11_000);
      });
    }
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    for (const o of orders) await creditedOnce(f, o);
    const reads = (key: string) =>
      f.config.get.mock.calls.filter(([appId, k]) => appId === f.appId && k === key).length;
    expect(reads('settle.auto.enabled')).toBeGreaterThanOrEqual(orders.length);
    expect(reads('credit.enabled.taobao')).toBeGreaterThanOrEqual(orders.length);
  },
  TIMEOUT,
);
