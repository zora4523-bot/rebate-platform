// B2-04zy rule tests on a real PostgreSQL (D10-732; BR-TEXT-09 「0 笔不发」, BR-FUND-04 ⑦): an
// execution that credited nothing publishes no settle.run_done, also when its batch reaches DONE
// (every item skipped or deferred). The batch still moves to DONE with settle.batch_done, and the
// run's watermark stays where it was. When another batch of the same execution did credit, the
// run publishes as before.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { SeededOrder } from '../credit/kit.ts';
import {
  NOTHING,
  TIMEOUT,
  at,
  creditedCount,
  creditedOnce,
  databaseFixture,
  delivered,
  fixture,
  nth,
  rig,
  runCredited,
  runState,
  untouched,
  watermarkReady,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** Order items whose settlement seq no longer matches: the credit skips them. */
function staleSeqs(orders: readonly SeededOrder[]): ReadonlyMap<string, number> {
  return new Map(orders.map((o): [string, number] => [o.orderId, o.seq + 1]));
}

it(
  '[AC-B2-04zy#5][D10-732][BR-TEXT-09] 首次执行零入账而批次照样 DONE：run 唯一一批的订单明细全因结算记录 seq 已变被跳过、受益人补记项暂缓 → 批次 DONE、发 settle.batch_done，但不发 settle.run_done，settle_runs 无发布（无行，或 part 0、无 outcome、水位 0），计数 0',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('zero-first', [2, 1]);
    const orders = at(groups, 0);
    const runId = randomUUID();
    const b = await f.batch(orders, { settle_run_id: runId }, staleSeqs(orders));
    const waiting = await f.beneficiaryItem(b, nth(at(groups, 1), 0), 'direct');
    r.answers.set(waiting.beneficiaryCreditId, { result: 'deferred' });

    await delivered(f, r.worker(), b, 'done');
    expect((await f.stored(b)).finished_at).not.toBeNull();
    expect(await f.batchDone(b)).toBe(1);
    for (const o of orders) {
      expect(await f.itemOf(b, o)).toMatchObject({ result: 'skipped' });
      await untouched(f, o);
    }
    expect(await f.item(b, waiting.beneficiaryCreditId)).toMatchObject({ result: 'deferred' });
    expect(await creditedCount(f, b)).toBe(0);
    expect(await f.runDone()).toEqual([]);
    expect(await runState(f, runId)).toEqual(NOTHING);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#5][D10-732][BR-TEXT-09] 续跑零入账而批次照样 DONE：单批 3 单，入账第 1 单后因开关停住 → part=1 partial（水位 1）；其余两单结算记录 seq 已变，继续执行把它们都跳过、批次 DONE → 不发 part=2，行仍为 part=1 partial、水位 1；settle.batch_done 照发一条',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const orders = at(await f.orderGroups('zero-continue', [3]), 0);
    const runId = randomUUID();
    const b = await f.batch(orders, { settle_run_id: runId }, staleSeqs(orders.slice(1)));
    const w = r.worker();

    r.stopAfter(nth(orders, 0));
    await delivered(f, w, b, 'partial');
    const partial = f.runEvent(runId, 1, 'partial', 1);
    expect(await f.runDone()).toStrictEqual([partial]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'partial', watermark: 1 });

    f.switchBackOn();
    await f.resume(b);
    await delivered(f, w, b, 'done');
    expect(await f.batchDone(b)).toBe(1);
    for (const o of orders.slice(1)) {
      expect(await f.itemOf(b, o)).toMatchObject({ result: 'skipped' });
      await untouched(f, o);
    }
    await creditedOnce(f, nth(orders, 0));
    expect(await creditedCount(f, b)).toBe(1);
    expect(await f.runDone()).toStrictEqual([partial]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'partial', watermark: 1 });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#5][BR-FUND-04][BR-TEXT-09] 对照：同一次执行里别的批次有入账照发——A 入账一单 DONE（run 未静止），B 的明细全被跳过、DONE → run 静止，各批计数之和 1 > 水位 0 → 发 part=1 done，水位 1',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('zero-mixed', [1, 2]);
    const [aOrders, bOrders] = [at(groups, 0), at(groups, 1)];
    const runId = randomUUID();
    const a = await f.batch(aOrders, { settle_run_id: runId });
    const b = await f.batch(bOrders, { settle_run_id: runId }, staleSeqs(bOrders));
    const w = r.worker();

    await delivered(f, w, a, 'done');
    expect(await f.runDone()).toEqual([]);
    await delivered(f, w, b, 'done');
    expect([await creditedCount(f, a), await creditedCount(f, b)]).toEqual([1, 0]);
    expect(await runCredited(f, runId)).toBe(1);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 2)]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'done', watermark: 1 });
    await creditedOnce(f, nth(aOrders, 0));
    for (const o of bOrders) await untouched(f, o);
  },
  TIMEOUT,
);
