// B2-06d / B2-06e: landing a channel result on the withdrawal (规划/08 BR-WDR-13, BR-WDR-14,
// BR-WDR-09; state machine W5 / W6). The transfer job (synchronous result) and the query job (a
// later query) end a PAYING withdrawal the same way, so both use this one piece of code:
//   success  W5 CHANNEL_SUCCESS → PAID_API: channel_order_id, paid_at (the channel's time when it
//            gives one, else `now` — the Clock when the success was received); the voucher
//            WITHDRAW:SUCCESS:CASH_<ALIPAY|BANK|WECHAT> `wd:{id}:PAID` through ledger.post on the
//            same transaction (zero fee / tax lines are dropped by the template); the event.
//   fail     W6 CHANNEL_FAIL → FAILED: fail_code = the caller's failCode, else sub_code, else
//            code; WITHDRAW:RETURN
//            `wd:{id}:RETURN`; the event.
// One business transaction per landing (the caller's, or its own) under the module's lock order
// (identity's users row → ledger.lockBalances); the transition is a CAS on (status PAYING, row_version) through the
// generated transitionWithdrawal(): 0 rows → logger.warn(conflictMessage), nothing written for it,
// no retry, no throw (the caller's attempt row stays as recorded). Logs carry ids and codes only.
import type { DB } from '@couli/db';
import { buildVouchers, transitionWithdrawal, type WithdrawalState } from '@couli/domain';
import type { Kysely, Transaction } from 'kysely';
import type { Ledger, PostingEntry } from '../../ledger/index.ts';
import type { EventBus } from '../../platform/index.ts';
import type { ChannelRaw } from '../domain/channel-result.ts';
import type { WithdrawApplyOptions } from './withdraw-apply.ts';
import type { PayoutChannelName } from '../infra/channels/payout-channel.ts';

/** The withdrawal columns a landing needs (read under the job's own row lock earlier). */
export interface LandingRow {
  readonly id: string;
  readonly app_id: string;
  readonly user_id: string;
  readonly row_version: number;
  readonly amount_fen: bigint;
  readonly net_fen: bigint;
  readonly fee_fen: bigint;
  readonly tax_fen: bigint;
  readonly out_biz_no: string;
  readonly payout_channel: string;
}

/** What a success or a definite failure carries (TransferResult and QueryResult both do). */
export interface LandingResult {
  readonly raw: ChannelRaw;
  /**
   * W6's fail_code when the caller knows better than the raw codes: the query job passes the
   * mapped order status when the response has no sub code (a query's 10000 is the gateway's
   * success code, not the failure). Default: sub_code, else code.
   */
  readonly failCode?: string;
  readonly channelOrderId?: string;
  /** ISO instant with an offset; the channel's time takes precedence over the Clock. */
  readonly paidAt?: string;
}

export interface LandingLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PayoutLandingOptions {
  readonly db: Kysely<DB>;
  readonly ledger: Ledger;
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly eventBus: EventBus;
  readonly logger: LandingLogger;
  /** The warn line of a CAS that moved no row (the caller's name, e.g. payout_transfer_cas_conflict). */
  readonly conflictMessage: string;
}

export interface PayoutLanding {
  /**
   * W5; false when the row moved meanwhile (nothing written). `trx`: an open business transaction
   * to land on whose caller already holds the users row (the worker's landing job locks users →
   * withdrawal first; the users lock is then not taken again); default: one transaction of its own
   * that takes users → balances itself.
   */
  success(
    row: LandingRow,
    result: LandingResult,
    now: Date,
    trx?: Transaction<DB>,
  ): Promise<boolean>;
  /** W6; false when the row moved meanwhile (nothing written). `trx` as for success. */
  fail(row: LandingRow, result: LandingResult, now: Date, trx?: Transaction<DB>): Promise<boolean>;
}

const PAYING: WithdrawalState = 'PAYING';
const CASH_SUBJECT: Readonly<Record<PayoutChannelName, string>> = {
  alipay: 'CASH_ALIPAY',
  bank_card: 'CASH_BANK',
  wechat: 'CASH_WECHAT',
};

/** A copy of `at` moved to `ms` (structuredClone + setTime: no `new Date` outside platform/clock). */
export function instant(at: Date, ms: number): Date {
  const copy = structuredClone(at);
  copy.setTime(ms);
  return copy;
}

/** paid_at of W5: the channel's instant when it is one, else `now`. */
export function paidAtOf(result: Pick<LandingResult, 'paidAt'>, now: Date): Date {
  return result.paidAt !== undefined && !Number.isNaN(Date.parse(result.paidAt))
    ? instant(now, Date.parse(result.paidAt))
    : now;
}

type BuiltEntry = {
  account: { owner_type: string; subject: string };
  sub_account: 'available' | 'frozen' | null;
  amount_fen: bigint;
  ledger_type: string;
  sub_type: string | null;
};

function userEntries(built: readonly BuiltEntry[], accountId: string): PostingEntry[] {
  return built.map((entry) => ({
    account:
      entry.account.owner_type === 'user'
        ? { ownerType: 'user', accountId }
        : { ownerType: 'platform', subject: entry.account.subject },
    sub_account: entry.sub_account === 'frozen' ? 'frozen' : 'available',
    amount_fen: entry.amount_fen,
    ledger_type: entry.ledger_type,
    sub_type: entry.sub_type,
    income_type: null,
  }));
}

export function createPayoutLanding(options: PayoutLandingOptions): PayoutLanding {
  const { db, ledger, lockUsersForUpdate, eventBus, logger, conflictMessage } = options;

  /**
   * The locks of a booking transition: users row → balance row (module lock order). On a caller's
   * transaction the users row is already held (the worker's landing job locks users → withdrawal
   * before calling), so only the balance row is taken here.
   */
  async function lockedAccount(
    trx: Transaction<DB>,
    row: LandingRow,
    lockUsers: boolean,
  ): Promise<string | null> {
    if (lockUsers) await lockUsersForUpdate(trx, { appId: row.app_id, userIds: [row.user_id] });
    const balances = await ledger.lockBalances(trx, { appId: row.app_id, userIds: [row.user_id] });
    const own = balances.find((balance) => balance.user_id === row.user_id);
    return own === undefined ? null : own.account_id;
  }

  async function cas(
    trx: Transaction<DB>,
    row: LandingRow,
    to: WithdrawalState,
    patch: Record<string, unknown>,
    now: Date,
  ): Promise<boolean> {
    const result = await trx
      .withSchema('app')
      .updateTable('withdrawals')
      .set({ ...patch, status: to, row_version: row.row_version + 1, updated_at: now })
      .where('app_id', '=', row.app_id)
      .where('id', '=', row.id)
      .where('status', '=', PAYING)
      .where('row_version', '=', row.row_version)
      .executeTakeFirst();
    if (result.numUpdatedRows === 1n) return true;
    logger.warn({ withdrawal_id: row.id, out_biz_no: row.out_biz_no, to }, conflictMessage);
    return false;
  }

  async function post(
    trx: Transaction<DB>,
    row: LandingRow,
    accountId: string,
    templateId: string,
    params: Readonly<Record<string, string | bigint>>,
  ): Promise<void> {
    const [voucher] = buildVouchers(templateId, params);
    if (voucher === undefined) throw new Error(`payout: ${templateId} built no voucher`);
    await ledger.post(trx, {
      appId: row.app_id,
      uniqKey: voucher.uniq_key,
      bizType: 'withdrawal',
      bizId: row.id,
      operator: 'system:payout',
      memo: null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: null,
      entries: userEntries(voucher.entries, accountId),
    });
  }

  async function publish(trx: Transaction<DB>, row: LandingRow, status: string): Promise<void> {
    await eventBus.publish(trx, {
      appId: row.app_id,
      name: 'wallet.withdrawal_changed',
      payload: { withdrawal_id: row.id, user_id: row.user_id, status },
    });
  }

  /** Runs `work` on `trx` when given, else on a transaction of its own. */
  function onTransaction<T>(
    trx: Transaction<DB> | undefined,
    work: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return trx === undefined ? db.transaction().execute(work) : work(trx);
  }

  return {
    async success(row, result, now, trx) {
      const own = trx === undefined;
      const transition = transitionWithdrawal(PAYING, 'CHANNEL_SUCCESS');
      if (!transition.ok || transition.noop) return false;
      const channel = row.payout_channel as PayoutChannelName;
      const subject = CASH_SUBJECT[channel];
      if (subject === undefined) {
        logger.warn({ withdrawal_id: row.id, out_biz_no: row.out_biz_no }, 'payout_no_channel');
        return false;
      }
      const paidAt = paidAtOf(result, now);
      return onTransaction(trx, async (trx) => {
        const accountId = await lockedAccount(trx, row, own);
        if (accountId === null) {
          logger.warn(
            { withdrawal_id: row.id, out_biz_no: row.out_biz_no },
            'payout_no_balance_row',
          );
          return false;
        }
        const moved = await cas(
          trx,
          row,
          transition.to,
          { paid_at: paidAt, channel_order_id: result.channelOrderId ?? null },
          now,
        );
        if (!moved) return false;
        await post(trx, row, accountId, `WITHDRAW:SUCCESS:${subject}`, {
          withdrawal_id: row.id,
          user_id: row.user_id,
          net_fen: row.net_fen,
          fee_fen: row.fee_fen,
          tax_fen: row.tax_fen,
        });
        await publish(trx, row, transition.to);
        return true;
      });
    },

    async fail(row, result, now, trx) {
      const own = trx === undefined;
      const transition = transitionWithdrawal(PAYING, 'CHANNEL_FAIL');
      if (!transition.ok || transition.noop) return false;
      return onTransaction(trx, async (trx) => {
        const accountId = await lockedAccount(trx, row, own);
        if (accountId === null) {
          logger.warn(
            { withdrawal_id: row.id, out_biz_no: row.out_biz_no },
            'payout_no_balance_row',
          );
          return false;
        }
        const moved = await cas(
          trx,
          row,
          transition.to,
          { fail_code: result.failCode ?? result.raw.subCode ?? result.raw.code },
          now,
        );
        if (!moved) return false;
        await post(trx, row, accountId, 'WITHDRAW:RETURN', {
          withdrawal_id: row.id,
          user_id: row.user_id,
          withdraw_fen: row.amount_fen,
        });
        await publish(trx, row, transition.to);
        return true;
      });
    },
  };
}
