// B2-11a: the default WithdrawRiskFactsReader (BR-WDR-29 ①②④⑤⑥⑦⑧⑩). Reads only on the handle
// given; payout's own tables directly, other modules' data only through their index.ts ports:
// orders and ledger imported here; commission's beneficiary shares (⑥) and identity's payee binding
// history (⑩) handed in as structural ports (app.module wires commission's
// createBeneficiaryShareReader and identity's createPayeeBindingHistoryReader), because their
// barrels carry Nest's decorated classes into the `test` project (as B2-05c / B2-05d's ports).
// A port not handed in makes its fact fail (→ risk_calc_failed), never answer false. Day and
// window bounds from @couli/domain, never a SQL clock. Nothing is written or logged. Rule tests:
// test/spec/payout/risk-flags/**.
// - Windows are [t − N × 24 h, t], both ends closed; ② is t's +08:00 day from 00:00 to t.
// - ⑥'s denominator: the sub-orders with a split row of the member (self / share / direct) whose
//   received_at is in the 60-day window and rebate_status WAITING (the split amount at the order's
//   current commission_version) or CREDITED (the ledger's net of the member per role, below 0
//   counted as 0, as B2-05c's self-purchase port).
// - ⑩: anchored at the binding time of the member's current account holding the payee HMAC; another
//   member's binding of it held at some instant of [anchor − 90 × 24 h, anchor] hits.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange, orderKey } from '@couli/domain';
import { addFen, parseFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import { createWithdrawRiskEntryReader, getOrderNets } from '../../ledger/index.ts';
import { createWithdrawRiskOrderReader } from '../../orders/index.ts';
import type {
  WithdrawRiskFactsReader,
  WithdrawRiskSubject,
} from '../application/withdraw-risk-port.ts';

const DAY_MS = 86_400_000;
/** ⑤⑥ 60 × 24 h; ⑥ 30 × 24 h; ⑩ 90 × 24 h (BR-WDR-02 细则「近 90 天」). */
const SELF_ORDER_WINDOW_MS = 60 * DAY_MS;
const RECEIVED_WINDOW_MS = 60 * DAY_MS;
const WITHDRAWN_WINDOW_MS = 30 * DAY_MS;
const PAYEE_WINDOW_MS = 90 * DAY_MS;
/** ⑥'s beneficiary roles (自购、分享、直推). */
const SHARE_ROLES: readonly string[] = ['self', 'share', 'direct'];
const PAID_STATUSES: readonly string[] = ['PAID_API', 'PAID_MANUAL'];
const NOT_COUNTED_STATUSES: readonly string[] = ['REJECTED', 'FAILED'];
const CREDIT_TYPES: readonly string[] = ['REBATE_CREDIT', 'SHARE_CREDIT', 'REFERRAL_CREDIT'];
/** Sub-orders per IN list (well under PG's parameter limit). */
const CHUNK = 1000;

/** `ms` before `at`, as a new instant (no Date constructor in app code). */
function before(at: Date, ms: number): Date {
  const result = structuredClone(at);
  result.setTime(at.getTime() - ms);
  return result;
}

/** 00:00 +08:00 of t's natural day (@couli/domain). */
function dayStart(at: Date): Date {
  const result = structuredClone(at);
  result.setTime(Date.parse(chinaDayRange(accountingDate(at)).start));
  return result;
}

/** commission's createBeneficiaryShareReader() (roles self / share / direct). */
export interface WithdrawRiskSharesPort {
  orderIds(
    handle: Kysely<DB>,
    input: { appId: string; userId: string },
  ): Promise<readonly string[]>;
  estimate(
    handle: Kysely<DB>,
    input: { appId: string; orderId: string; commissionVersion: number; userId: string },
  ): Promise<bigint>;
}

/** identity's createPayeeBindingHistoryReader(). */
export interface WithdrawRiskPayeeHistoryPort {
  currentBinding(
    handle: Kysely<DB>,
    input: { appId: string; userId: string; payeeHmac: string },
  ): Promise<Date | null>;
  heldByOtherBetween(
    handle: Kysely<DB>,
    input: { appId: string; userId: string; payeeHmac: string; from: Date; to: Date },
  ): Promise<boolean>;
}

export interface WithdrawRiskFactsPorts {
  readonly shares?: WithdrawRiskSharesPort;
  readonly payeeHistory?: WithdrawRiskPayeeHistoryPort;
}

function unwired(name: string): never {
  throw new Error(`payout: the ${name} port of the risk facts reader is not wired`);
}

export function createWithdrawRiskFactsReader(
  ports: WithdrawRiskFactsPorts = {},
): WithdrawRiskFactsReader {
  const orders = createWithdrawRiskOrderReader();
  const entries = createWithdrawRiskEntryReader();

  async function creditedNet(
    handle: Kysely<DB>,
    subject: WithdrawRiskSubject,
    key: string,
  ): Promise<bigint> {
    const selection = { appId: subject.appId, orderKey: key };
    const nets = handle.isTransaction
      ? await getOrderNets(handle as Transaction<DB>, selection)
      : await handle.transaction().execute((trx) => getOrderNets(trx, selection));
    let total = 0n;
    for (const net of nets.beneficiaries) {
      if (net.beneficiary_user_id !== subject.userId) continue;
      if (!SHARE_ROLES.includes(net.role)) continue;
      if (net.net_fen > 0n) total = addFen(total, net.net_fen);
    }
    return total;
  }

  return {
    async hasPaidWithdrawal(handle, subject) {
      const row = await handle
        .withSchema('app')
        .selectFrom('withdrawals')
        .select('id')
        .where('app_id', '=', subject.appId)
        .where('user_id', '=', subject.userId)
        .where('status', 'in', [...PAID_STATUSES])
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    creditedToday(handle, subject) {
      return entries.creditedBetween(handle, {
        appId: subject.appId,
        userId: subject.userId,
        ledgerTypes: CREDIT_TYPES,
        from: dayStart(subject.now),
        to: subject.now,
      });
    },

    async selfOrders60d(handle, subject) {
      const rows = await orders.selfOrders(handle, {
        appId: subject.appId,
        userId: subject.userId,
        from: before(subject.now, SELF_ORDER_WINDOW_MS),
        to: subject.now,
      });
      return rows.map((row) => ({
        invalid: row.invalid,
        est_commission_fen: row.est_commission_fen,
        commission_base_fen: row.pay_amount_fen,
      }));
    },

    async withdrawn30dFen(handle, subject) {
      const row = await handle
        .withSchema('app')
        .selectFrom('withdrawals')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('amount_fen'), eb.val('0')).as('total'))
        .where('app_id', '=', subject.appId)
        .where('user_id', '=', subject.userId)
        .where('status', 'not in', [...NOT_COUNTED_STATUSES])
        .where('created_at', '>=', before(subject.now, WITHDRAWN_WINDOW_MS))
        .where('created_at', '<=', subject.now)
        .executeTakeFirstOrThrow();
      return parseFen(row.total);
    },

    async received60dFen(handle, subject) {
      const shares = ports.shares ?? unwired('shares');
      const ids = await shares.orderIds(handle, { appId: subject.appId, userId: subject.userId });
      const from = before(subject.now, RECEIVED_WINDOW_MS);
      let total = 0n;
      for (let start = 0; start < ids.length; start += CHUNK) {
        const received = await orders.receivedOrders(handle, {
          appId: subject.appId,
          orderIds: ids.slice(start, start + CHUNK),
          from,
          to: subject.now,
        });
        for (const order of received) {
          const share =
            order.rebate_status === 'CREDITED'
              ? await creditedNet(handle, subject, orderKey(order.platform, order.sub_order_id))
              : await shares.estimate(handle, {
                  appId: subject.appId,
                  orderId: order.order_id,
                  commissionVersion: order.commission_version,
                  userId: subject.userId,
                });
          total = addFen(total, share);
        }
      }
      return total;
    },

    hadNegative(handle, subject) {
      return entries.hadNegative(handle, { appId: subject.appId, userId: subject.userId });
    },

    async reconDiff(handle, subject) {
      const row = await handle
        .withSchema('app')
        .selectFrom('withdraw_holds')
        .select('id')
        .where('app_id', '=', subject.appId)
        .where('user_id', '=', subject.userId)
        .where('reason', '=', 'recon_diff')
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async payeePrevOtherUser(handle, subject) {
      const bindings = ports.payeeHistory ?? unwired('payeeHistory');
      const anchor = await bindings.currentBinding(handle, {
        appId: subject.appId,
        userId: subject.userId,
        payeeHmac: subject.payeeHmac,
      });
      if (anchor === null) return false;
      return bindings.heldByOtherBetween(handle, {
        appId: subject.appId,
        userId: subject.userId,
        payeeHmac: subject.payeeHmac,
        from: before(anchor, PAYEE_WINDOW_MS),
        to: anchor,
      });
    },
  };
}
