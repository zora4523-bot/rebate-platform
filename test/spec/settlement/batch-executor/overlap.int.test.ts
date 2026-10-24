// B2-04p rule tests on a real PostgreSQL: one WAITING sub-order in two batches. BR-FUND-04 细则
// 「结算批次迁移表」表下: a sub-order may be in several batches; each execution re-validates it (⑦) and
// one already credited is recorded skipped; a batch stuck in PARTIAL does not keep its sub-orders
// out of later batches. The main batch stops in PARTIAL (switch off), a supplement batch takes the
// same sub-order; both execution orders credit it exactly once and the later item is skipped with
// the B2-04m reason not_waiting (B2-04r review, out of scope S1).
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
  type Fixture,
  type SeededBatch,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

async function finish(f: Fixture, b: SeededBatch, resumeFirst: boolean): Promise<void> {
  if (resumeFirst) await f.resume(b);
  expect(await f.run(b)).toMatchObject({ outcome: 'done' });
  expect((await f.stored(b)).status).toBe('DONE');
}

it.each(['main_first', 'supplement_first'] as const)(
  '[AC-B2-04p#24] 同一子订单同时在 PARTIAL 主批次与补充批次中（%s）：只入账一次，先执行的明细 credited，后执行的明细 skipped / not_waiting',
  async (sequence) => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, `overlap-${sequence}`, 2);
    const head = nth(orders, 0);
    const shared = nth(orders, 1);
    const main = await f.batch([head, shared]);
    const supplement = await f.batch([shared], { kind: 'supplement' });

    // 主批次第 1 单的事务里关掉 settle.auto.enabled：第 2 单前停住，主批次 PARTIAL。
    f.onCredit(head, async () => {
      f.switches.set('settle.auto.enabled', false);
      f.clock.advanceMs(11_000);
    });
    expect(await f.run(main)).toMatchObject({ outcome: 'partial' });
    expect((await f.stored(main)).status).toBe('PARTIAL');
    expect((await f.itemOf(main, shared)).result).toBeNull();
    await untouched(f, shared);

    f.switches.set('settle.auto.enabled', true);
    f.clock.advanceMs(11_000);
    const [earlier, later] = sequence === 'main_first' ? [main, supplement] : [supplement, main];
    await finish(f, earlier, earlier === main);
    await finish(f, later, later === main);

    expect(await f.itemOf(earlier, shared)).toMatchObject({
      result: 'credited',
      skip_reason: null,
    });
    expect(await f.itemOf(later, shared)).toMatchObject({
      result: 'skipped',
      skip_reason: 'not_waiting',
    });
    await creditedOnce(f, shared);
    await creditedOnce(f, head);
    expect((await f.itemOf(main, head)).result).toBe('credited');
  },
  TIMEOUT,
);
