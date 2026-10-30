// Shared harness of the B2-04lb rule tests (D10-463): rights results and the union's new commission
// around the credit. Built on the B2-04l rights harness: the real rights command, the real B2-04m
// credit, the real B2-04s clawback and the real B2-04j rebate port (commission's valuation is the
// kit's test double). The simulated order sync writes on one transaction what orders writes (the
// commission columns, row_version) plus, when asked, the union's new order_settlements record, then
// calls settlement's sync hook on that same transaction: rebate.onUpdated before credit, the
// clawback's onUpdated on a CREDITED order. Expected amounts are written by hand in the tests.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Kysely } from 'kysely';
import type { DB } from '@couli/db';
import {
  lockOrderKey,
  type OrderStatusSource,
  type OrderUpdateChange,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { ClawbackResult } from '../../../../apps/api/src/modules/settlement/clawback/index.ts';
import { creditKey, platformKey, platformLines, userCreditLines } from '../credit/kit.ts';
import { harness as rightsHarness, receivable, type SeededOrder } from '../rights/kit.ts';

export {
  NOW,
  RIGHTS_NO,
  TIMEOUT,
  clawbackKey,
  databaseFixture,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  userClawbackLines,
} from '../rights/kit.ts';
export type { OrderSpec, SeededOrder } from '../rights/kit.ts';
export { creditKey, platformKey, platformLines, userCreditLines } from '../credit/kit.ts';

/** A later instant than NOW (the injected clock is moved there before the union's new record). */
export const LATER = '2032-07-26T10:00:00+08:00';

/** An order before WAITING: ESTIMATED, platform PAID, no settlement record (est 3222). */
export const ESTIMATED = {
  seqs: [],
  patch: { rebate_status: 'ESTIMATED', platform_status: 'PAID', received_at: null },
} as const;

export interface UnionSyncSpec {
  readonly event: OrderStatusSource['event'];
  /** New est_commission_fen (default unchanged). */
  readonly estAfter?: bigint | null;
  /** New orders.settle_commission_fen (default unchanged). */
  readonly settleAfter?: bigint;
  /**
   * The union's new settlement record written on the sync transaction: order_settlements seq
   * `newSeq`, source STATEMENT, amount settleAfter, settled_at / created_at = the clock's now.
   */
  readonly newSeq?: number;
}

export interface UnionSyncOutcome {
  readonly change: OrderUpdateChange;
  readonly source: OrderStatusSource;
  /** The clawback's result on a CREDITED order; null before credit (rebate.onUpdated). */
  readonly result: ClawbackResult | null;
}

/** Hand-written credit of one order (BR-CALC-02 / BR-CALC-04 / BR-FUND-05). */
export interface CreditAmounts {
  /** B_credit (booked_base_fen). */
  readonly base: bigint;
  /** N (booked_n_fen; also the order's UNION_RECEIVABLE net with no held beneficiary). */
  readonly n: bigint;
  readonly self: bigint;
  readonly direct: bigint;
  readonly indirect: bigint;
  /** PLATFORM:CREDIT = retain + reserve. */
  readonly platform: bigint;
}

const ROLES = ['self', 'direct', 'indirect'] as const;

export async function harness(db: Kysely<DB>) {
  const h = await rightsHarness(db);
  const appId = h.appId;

  /**
   * One simulated order sync: lockOrderKey, the order re-read FOR UPDATE, the union's new record
   * (when asked) and the orders column update (row_version + 1) on one transaction, then the hook.
   * A changed commission moves commission_version first (with the snapshot copied), as orders does.
   */
  async function unionSync(
    o: SeededOrder,
    spec: UnionSyncSpec,
    hook: 'rebate' | 'clawback',
  ): Promise<UnionSyncOutcome> {
    const current = await h.read(o);
    const estAfter = spec.estAfter === undefined ? current.est_commission_fen : spec.estAfter;
    const settleAfter =
      spec.settleAfter === undefined ? current.settle_commission_fen : spec.settleAfter;
    if (estAfter !== current.est_commission_fen || settleAfter !== current.settle_commission_fen) {
      await h.bumpCommissionVersion(o, current.commission_version + 1);
    }
    const clawback = hook === 'clawback' ? h.boot() : null;
    return db.transaction().execute(async (trx) => {
      await lockOrderKey(trx, o.platform, o.subOrderId);
      const before = await trx
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', appId)
        .where('order_id', '=', o.orderId)
        .where('attr_at', '=', o.attrAt)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (spec.newSeq !== undefined) {
        if (settleAfter === null) {
          throw new Error('rights-credit harness: a new record needs an amount');
        }
        await trx
          .insertInto('order_settlements')
          .values({
            app_id: appId,
            order_id: o.orderId,
            seq: spec.newSeq,
            source: 'STATEMENT',
            settle_commission_fen: settleAfter,
            settled_at: h.clock.now(),
            content_hash: randomUUID(),
            created_at: h.clock.now(),
          })
          .execute();
      }
      await trx
        .updateTable('orders')
        .set({
          est_commission_fen: estAfter,
          settle_commission_fen: settleAfter,
          row_version: before.row_version + 1,
          updated_at: h.clock.now(),
        })
        .where('app_id', '=', appId)
        .where('order_id', '=', o.orderId)
        .where('attr_at', '=', o.attrAt)
        .execute();
      const change: OrderUpdateChange = {
        app_id: appId,
        order_id: o.orderId,
        attr_at: before.attr_at,
        from_status: before.platform_status,
        to_status: before.platform_status,
        rule: null,
        received_at: before.received_at,
        est_before: before.est_commission_fen,
        est_after: estAfter,
        settle_commission_fen: settleAfter,
        attributed_now: false,
      };
      const source: OrderStatusSource = { event: spec.event, raw_status: 'synthetic' };
      if (clawback === null) {
        await h.rebate.onUpdated(trx, change, source);
        return { change, source, result: null };
      }
      return { change, source, result: await clawback.onUpdated(trx, change, source) };
    });
  }

  /** The order sync of a not yet credited order (orders calls rebate.onUpdated). */
  function syncBeforeCredit(o: SeededOrder, spec: UnionSyncSpec): Promise<UnionSyncOutcome> {
    return unionSync(o, spec, 'rebate');
  }

  /** The order sync of a CREDITED order (orders calls the clawback's onUpdated). */
  function syncCredited(o: SeededOrder, spec: UnionSyncSpec): Promise<UnionSyncOutcome> {
    return unionSync(o, spec, 'clawback');
  }

  /** The credit (R5) against settlement record `seq` (default: the seeded greatest seq). */
  function creditAt(o: SeededOrder, seq?: number) {
    return h.credit(o, { input: { expectedSettleSeq: seq ?? o.seq } });
  }

  /** The order's credit vouchers, balances, receivable and booked pair equal `a` exactly. */
  async function expectCredited(o: SeededOrder, a: CreditAmounts): Promise<void> {
    const keys: string[] = [];
    for (const role of ROLES) {
      const share = a[role];
      expect(await h.balance(o.user(role)), role).toBe(share);
      if (share > 0n) {
        keys.push(creditKey(o, role));
        expect(await h.voucherLines(creditKey(o, role)), role).toEqual(
          userCreditLines(o, role, share),
        );
      }
    }
    if (a.platform > 0n) {
      keys.push(platformKey(o));
      expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, a.platform));
    }
    expect(await h.orderVoucherKeys(o)).toEqual(keys.sort());
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(a.n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: a.base,
      booked_n_fen: a.n,
    });
  }

  /** Beneficiary nets (balances), UNION_RECEIVABLE net and booked pair of a CREDITED order. */
  async function expectNets(
    o: SeededOrder,
    a: Pick<CreditAmounts, 'base' | 'n' | 'self' | 'direct' | 'indirect'>,
  ): Promise<void> {
    for (const role of ROLES) {
      expect(await h.balance(o.user(role)), role).toBe(a[role]);
      expect(await h.netOf(o, role), role).toBe(a[role]);
    }
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(a.n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: a.base,
      booked_n_fen: a.n,
    });
  }

  /** What a replay must leave unchanged on the order (vouchers, balances, rebate columns, rights). */
  async function moneyState(o: SeededOrder) {
    return {
      keys: await h.orderVoucherKeys(o),
      balances: await Promise.all(ROLES.map((role) => h.balance(o.user(role)))),
      columns: await h.rebateColumns(o),
      rights: await h.rightsRows(o),
    };
  }

  return {
    ...h,
    syncBeforeCredit,
    syncCredited,
    creditAt,
    expectCredited,
    expectNets,
    moneyState,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;
