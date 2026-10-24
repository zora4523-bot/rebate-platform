// B2-04p rule tests on a real PostgreSQL: the item loop. BR-FUND-04 ⑦ (one PG transaction per
// sub-order, re-validated by B2-04m, skipped ones keep WAITING and the item keeps the reason), ⑫
// (beneficiary items through the B2-04q port), SB6 (DONE and settle.batch_done on one transaction);
// 规划/12 §4.3 (ascending order_key, an item with a result is not executed again) and §4.4 (the item
// result is written on the credit's transaction).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { failAfter } from '../credit/kit.ts';
import {
  NOW,
  TIMEOUT,
  creditedOnce,
  databaseFixture,
  fixture,
  nth,
  p0Orders,
  untouched,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04p#9] 明细按 order_key 升序逐条执行，每条一个独立事务；入账入参取明细的 settle_seq，开立引用为明细 id',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'order', 4);
    // 明细按相反顺序写入，执行顺序只看 order_key。
    const b = await f.batch([...orders].reverse());
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });

    expect(f.creditCalls.map((c) => c.input.orderId)).toEqual(orders.map((o) => o.orderId));
    expect(new Set(f.creditCalls.map((c) => c.trx)).size).toBe(orders.length);
    for (const [index, o] of orders.entries()) {
      expect(f.creditCalls[index]?.input).toMatchObject({
        appId: f.appId,
        orderId: o.orderId,
        expectedSettleSeq: o.seq,
        openedRef: b.items.get(o.orderId),
      });
      await creditedOnce(f, o);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#10] 执行校验不过的子订单记 skipped 与 B2-04m 的原因（hold / rights_pending / settlement_changed / tlj_deduct_unsupported），订单保持 WAITING、不写凭证；其余照常入账，批次 DONE',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'skip', 5, (i) =>
      i === 2
        ? { patch: { hold: true, hold_reason: 'CS' } }
        : i === 3
          ? { patch: { rights_pending: true } }
          : i === 5
            ? { tljDeductFen: 10n }
            : {},
    );
    // 第 4 单校验时的结算记录是 seq 1，之后又到了 seq 2（BR-FUND-04 ⑦：seq 不一致即跳过）。
    const b = await f.batch(orders, {}, new Map([[nth(orders, 3).orderId, 1]]));
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    expect((await f.stored(b)).status).toBe('DONE');

    await creditedOnce(f, nth(orders, 0));
    expect(await f.itemOf(b, nth(orders, 0))).toMatchObject({
      result: 'credited',
      skip_reason: null,
    });
    const reasons = ['hold', 'rights_pending', 'settlement_changed', 'tlj_deduct_unsupported'];
    for (const [index, reason] of reasons.entries()) {
      const o = nth(orders, index + 1);
      await untouched(f, o);
      expect(await f.itemOf(b, o)).toMatchObject({
        result: 'skipped',
        skip_reason: reason,
        amount_fen: null,
      });
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#11] 明细结果与入账同一事务：写第 2 条明细结果的语句执行后失败 → 该单入账整体回滚、明细仍未处理，批次保持 EXECUTING；再投递从这条续跑，每单只入账一次',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'atomic', 3);
    const b = await f.batch(orders);
    const second = nth(orders, 1);
    const target = b.items.get(second.orderId);
    const faulty = failAfter(
      p.db,
      (q) =>
        /^update\s+(?:"app"\.)?"settle_batch_items"/i.test(q.sql) &&
        q.parameters.some((v) => v === target || v === second.orderId),
    );
    await expect(Promise.resolve().then(() => f.run(b, faulty.db))).rejects.toThrow(
      'injected failure after the statement ran',
    );
    expect(faulty.injected()).toBe(1);

    await creditedOnce(f, nth(orders, 0));
    expect((await f.itemOf(b, nth(orders, 0))).result).toBe('credited');
    await untouched(f, second);
    expect((await f.itemOf(b, second)).result).toBeNull();
    await untouched(f, nth(orders, 2));
    expect((await f.stored(b)).status).toBe('EXECUTING');

    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    for (const o of orders) {
      await creditedOnce(f, o);
      expect((await f.itemOf(b, o)).result).toBe('credited');
    }
    const calls = (o: (typeof orders)[number]) =>
      f.creditCalls.filter((c) => c.input.orderId === o.orderId).length;
    expect(orders.map(calls)).toEqual([1, 2, 1]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#12] 受益人补记项经 B2-04q 端口执行，各自独立事务；明细按返回记 credited + amount_fen、deferred、skipped + skip_reason',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'bene', 3);
    const b = await f.batch([nth(orders, 0)]);
    const credited = await f.beneficiaryItem(b, nth(orders, 1), 'self');
    const held = await f.beneficiaryItem(b, nth(orders, 1), 'direct');
    const closed = await f.beneficiaryItem(b, nth(orders, 2), 'self');
    f.beneficiaryAnswers.set(credited.beneficiaryCreditId, { result: 'credited', amountFen: 37n });
    f.beneficiaryAnswers.set(held.beneficiaryCreditId, { result: 'deferred' });
    f.beneficiaryAnswers.set(closed.beneficiaryCreditId, {
      result: 'skipped',
      reason: 'obligation_closed',
    });

    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    await creditedOnce(f, nth(orders, 0));

    expect(f.beneficiaryCalls).toHaveLength(3);
    const byId = new Map(f.beneficiaryCalls.map((c) => [c.input.beneficiaryCreditId, c]));
    const expected = [
      [credited, nth(orders, 1), 'self'],
      [held, nth(orders, 1), 'direct'],
      [closed, nth(orders, 2), 'self'],
    ] as const;
    for (const [entry, o, role] of expected) {
      expect(byId.get(entry.beneficiaryCreditId)?.input).toMatchObject({
        appId: f.appId,
        batchId: b.batchId,
        itemId: entry.itemId,
        orderId: o.orderId,
        userId: o.user(role),
        role,
        beneficiaryCreditId: entry.beneficiaryCreditId,
        expectedSettleSeq: o.seq,
      });
    }
    // 子订单项与三条补记项：四个不同的事务。
    const transactions = [...f.creditCalls, ...f.beneficiaryCalls].map((c) => c.trx);
    expect(new Set(transactions).size).toBe(4);

    expect(await f.item(b, credited.beneficiaryCreditId)).toMatchObject({
      result: 'credited',
      amount_fen: 37n,
      skip_reason: null,
    });
    expect(await f.item(b, held.beneficiaryCreditId)).toMatchObject({
      result: 'deferred',
      amount_fen: null,
      skip_reason: null,
    });
    expect(await f.item(b, closed.beneficiaryCreditId)).toMatchObject({
      result: 'skipped',
      amount_fen: null,
      skip_reason: 'obligation_closed',
    });
    expect((await f.stored(b)).status).toBe('DONE');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#13] SB6 与 settle.batch_done 同一事务：发布失败 → 批次保持 EXECUTING、finished_at 为空、无事件；再投递只补完成，不重复入账，恰好一条 settle.batch_done',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'done', 2);
    const b = await f.batch(orders);
    f.refuseDone();
    await expect(Promise.resolve().then(() => f.run(b))).rejects.toThrow(
      'settle.batch_done refused by the test',
    );
    expect(await f.stored(b)).toMatchObject({ status: 'EXECUTING', finished_at: null });
    expect(await f.doneEvents()).toHaveLength(0);
    for (const o of orders) {
      await creditedOnce(f, o);
      expect((await f.itemOf(b, o)).result).toBe('credited');
    }

    f.clock.advanceMs(60_000);
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    expect(await f.stored(b)).toMatchObject({
      status: 'DONE',
      finished_at: new Date(Date.parse(NOW) + 60_000),
    });
    expect(await f.doneEvents()).toHaveLength(1);
    expect(f.creditCalls).toHaveLength(orders.length);
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#14] 完成时为本 app 发布一条带 batch_id 的 settle.batch_done；DONE 之后重复投递 idle，不再发布、不改任何东西',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'event', 1);
    const b = await f.batch(orders);
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });

    const doneCalls = () =>
      f.executorPublish.mock.calls.filter(([, e]) => e.name === 'settle.batch_done');
    const published = doneCalls();
    expect(published).toHaveLength(1);
    expect(published[0]?.[1]).toMatchObject({
      appId: f.appId,
      name: 'settle.batch_done',
      payload: expect.objectContaining({ batch_id: b.batchId }),
    });
    expect(await f.doneEvents()).toHaveLength(1);

    const before = await f.snapshot();
    expect(await f.run(b)).toMatchObject({ outcome: 'idle' });
    expect(await f.snapshot()).toEqual(before);
    expect(doneCalls()).toHaveLength(1);
  },
  TIMEOUT,
);
