// B2-04ze round 2 (review r1 S1 / S2): the batch execution assembled by SettlementModule.forWorker
// reaches the real credits with the ports app.module hands in.
// - readAttribution (commission readCommissionAttribution) is what both credit factories read the
//   attribution through (createCreditOrder for order items, createBeneficiaryCredit for beneficiary
//   items); readSnapshot is never called by them, so an order whose commission_version order-sync
//   moved to 2 without v2 snapshot rows still credits (HANDOFF 10-27, D10-317; BR-FUND-04 ⑦ ⑫).
// - the minors reader (identity B1-03zc) is what the BeneficiaryGate asks: an identified minor's
//   promotion share is forfeited (reason minor), the own share credited (BR-ID-26, BR-CALC-13; same
//   reading as B2-04m [AC-B2-04m#17]).
// Switches as they are: credit.enabled.taobao on, settle.auto.enabled unset (default on).
// Amounts as in the B2-04m / B2-04p kits: P0 (N 1000, no reserve) → self 400, direct 80; default
// people (N 1000, reserve 1500) → B_credit 850, self 425 / direct 85 / indirect 42.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, creditedOnce, databaseFixture, fixture, p0 } from '../batch-executor/kit.ts';
import {
  NOW,
  creditKey,
  forfeitKey,
  platformKey,
  platformLines,
  userCreditLines,
} from '../credit/kit.ts';
import {
  beneficiaryItemOf,
  bumpCommissionVersion,
  snapshotRefused,
  withWorker,
  workerPorts,
} from './credit-kit.ts';
import { EXECUTE, FAKE_CRYPTO, TAOBAO, isTransaction, receivedJob } from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** credit.enabled.taobao on; settle.auto.enabled left unset (its default is on). */
function creditOn(): Map<string, unknown> {
  return new Map<string, unknown>([[`credit.enabled.${TAOBAO}`, true]]);
}

interface AttributionRead {
  readonly inTransaction: boolean;
  readonly appId: string;
  readonly orderId: string;
}

function byOrderId(a: { readonly orderId: string }, b: { readonly orderId: string }): number {
  return a.orderId < b.orderId ? -1 : 1;
}

/** Every readAttribution call of the worker ports, ordered by order id. */
function attributionReads(w: ReturnType<typeof workerPorts>): AttributionRead[] {
  const reads = w.readAttribution.mock.calls.map(([trx, input]) => ({
    inTransaction: isTransaction(trx),
    appId: input.appId,
    orderId: input.orderId,
  }));
  return reads.sort(byOrderId);
}

it(
  '[AC-B2-04ze#29] forWorker 装配的 batch_execute：两个 WAITING 子订单（一单 commission_version=1，一单被 order-sync 升到 2 且无 v2 快照行）都经注入的 readAttribution 读归属并照常入账（400 / 80），批次 DONE；readSnapshot 一次都不调用（不整单回滚）',
  async () => {
    const f = await fixture(p.db);
    const h = f.h;
    const kept = await h.order(p0(`sw-attr-${h.appId}-01`));
    const bumped = await h.order(p0(`sw-attr-${h.appId}-02`));
    await bumpCommissionVersion(h, bumped, 2);
    // The reproduced state: the version-asserting reader refuses exactly the bumped order.
    await snapshotRefused(h, bumped, 2);
    const batch = await f.batch([kept, bumped]);
    const w = workerPorts(h, creditOn());

    await withWorker(w.ports, h, p.db, async (handler) => {
      await handler(receivedJob(EXECUTE, { app_id: h.appId, batch_id: batch.batchId }));
    });

    expect((await f.stored(batch)).status).toBe('DONE');
    for (const o of [kept, bumped]) {
      expect(await f.itemOf(batch, o)).toMatchObject({ result: 'credited', skip_reason: null });
      await creditedOnce(f, o);
    }
    // The credit leaves the version order-sync wrote.
    expect((await h.read(bumped)).commission_version).toBe(2);
    const expected = [kept, bumped].map((o) => ({
      inTransaction: true,
      appId: h.appId,
      orderId: o.orderId,
    }));
    expect(attributionReads(w)).toStrictEqual(expected.sort(byOrderId));
    expect(w.readSnapshot).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#30] forWorker 装配的 batch_execute：受益人补记项（直推入账时冻结开了首次入账义务，现已恢复正常；订单此后被 order-sync 升到 commission_version=2、无 v2 快照行）经注入的 readAttribution 执行，补记 85 写 CREDIT 键凭证、义务完成（R5a，closed_ref = 批次明细 id），明细 credited 85，批次 DONE；readSnapshot 不调用',
  async () => {
    const f = await fixture(p.db);
    const h = f.h;
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'frozen' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    // R5 earlier (B2-04m, version 1): the frozen direct share is held, its obligation opened.
    expect(await h.credit(o)).toMatchObject({ outcome: 'credited', bCreditFen: 850n });
    const [obligation] = (await h.obligations()).filter((row) => row.order_id === o.orderId);
    expect(obligation).toMatchObject({
      user_id: o.user('direct'),
      role: 'direct',
      kind: 'first_credit',
      status: 'open',
    });
    if (obligation === undefined) throw new Error('unreachable: the expect above failed');
    await h.setRisk(h.db, o.user('direct'), 'normal');
    await bumpCommissionVersion(h, o, 2);
    await snapshotRefused(h, o, 2);
    const batch = await f.batch([]);
    const itemId = await beneficiaryItemOf(h, batch.batchId, o, obligation);
    const w = workerPorts(h, creditOn());

    await withWorker(w.ports, h, p.db, async (handler) => {
      await handler(receivedJob(EXECUTE, { app_id: h.appId, batch_id: batch.batchId }));
    });

    expect((await f.stored(batch)).status).toBe('DONE');
    const item = await h.db
      .selectFrom('settle_batch_items')
      .select(['result', 'amount_fen', 'skip_reason'])
      .where('app_id', '=', h.appId)
      .where('id', '=', itemId)
      .executeTakeFirstOrThrow();
    expect(item).toStrictEqual({ result: 'credited', amount_fen: 85n, skip_reason: null });
    expect(await h.voucherLines(creditKey(o, 'direct'))).toEqual(userCreditLines(o, 'direct', 85n));
    expect(await h.balance(o.user('direct'))).toBe(85n);
    const [closed] = (await h.obligations()).filter((row) => row.order_id === o.orderId);
    expect(closed).toMatchObject({
      beneficiary_credit_id: obligation.beneficiary_credit_id,
      status: 'done',
      closed_by: 'R5a',
      closed_ref: itemId,
    });
    expect((await h.read(o)).commission_version).toBe(2);
    expect(attributionReads(w)).toStrictEqual([
      { inTransaction: true, appId: h.appId, orderId: o.orderId },
    ]);
    expect(w.readSnapshot).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#31] forWorker 的闸门用注入的 minors 读口（经进程字段密钥构造）：已识别未成年的直推份额没收（FORFEIT 85，forfeited 事件 reason=minor），本人 425 与间推 42 照常入账，平台 448；明细 credited，批次 DONE',
  async () => {
    const f = await fixture(p.db);
    const h = f.h;
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000, state: 'minor' },
        { role: 'direct', ratioBp: 1000, state: 'minor' },
        { role: 'indirect', ratioBp: 500, state: 'adult' },
      ],
    });
    const batch = await f.batch([o]);
    const w = workerPorts(h, creditOn());

    await withWorker(w.ports, h, p.db, async (handler) => {
      await handler(receivedJob(EXECUTE, { app_id: h.appId, batch_id: batch.batchId }));
    });

    expect((await f.stored(batch)).status).toBe('DONE');
    expect(await f.itemOf(batch, o)).toMatchObject({ result: 'credited', skip_reason: null });
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'indirect'),
        platformKey(o),
        forfeitKey(o, 'direct'),
      ].sort(),
    );
    expect(await h.balance(o.user('self'))).toBe(425n);
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.balance(o.user('indirect'))).toBe(42n);
    expect(await h.voucherLines(forfeitKey(o, 'direct'))).toEqual(platformLines(o, 85n));
    expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, 448n));
    expect(await h.newBeneficiaryEvents(o)).toEqual([
      expect.objectContaining({ user_id: o.user('direct'), status: 'forfeited', reason: 'minor' }),
    ]);
    expect(w.minors).toHaveBeenCalledWith(FAKE_CRYPTO);
    const direct = o.user('direct');
    const at = new Date(NOW).getTime();
    const asked = h.minorRead.mock.calls.filter(([trx, input]) => {
      const sameRead = input.appId === h.appId && input.at.getTime() === at;
      return isTransaction(trx) && sameRead && input.userIds.includes(direct);
    });
    expect(asked.length).toBeGreaterThan(0);
  },
  TIMEOUT,
);
