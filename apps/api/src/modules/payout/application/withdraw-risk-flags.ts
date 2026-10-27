// B2-11a: BR-WDR-29 审核风险标签快照 at BR-WDR-03 ⑭ (task 9.3). W1 (withdraw-apply.ts) calls
// compute() inside its transaction after the first pass and before the locks, with t = that
// application's Clock now and the id the insert will use; the result goes into the withdrawal row
// (risk_flags, risk_flags_at = t) and is never recomputed. A refused first pass computes nothing.
// - ①②④⑤⑥⑦⑧⑩ from WithdrawRiskFactsReader (default: ../infra/withdraw-risk-facts.ts); ③ only
//   through risk's SameDeviceAccountsCheck (BR-ID-37) with ref {type: 'withdrawal', id}.
// - Each item runs in its own savepoint: a failed (or timed out) read rolls back to it, the item
//   gives no label, and one trailing {code: 'risk_calc_failed', value: [failed codes], threshold:
//   null} is added; the application is never refused for it. Labels in BR order, hits only, [] when
//   none.
// - Thresholds risk.withdraw.* through the configuration port; missing, malformed or unreadable →
//   the defaults 3000 / 3 / 5000 / 5000 / 5 / 10000.
// Rule tests: test/spec/payout/risk-flags/**.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import { addFen } from '@couli/money';
import { sql, type Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { SameDeviceAccountsCheck } from '../../risk/index.ts';
import {
  highCommissionRatioFlag,
  invalidRatioFlag,
  withdrawVsReceivedFlag,
  type SelfOrderFact,
  type WithdrawRiskFlag,
  type WithdrawRiskFlagCode,
  type WithdrawRiskThresholds,
} from '../domain/risk-flags.ts';
import { createWithdrawRiskFactsReader } from '../infra/withdraw-risk-facts.ts';
import type { WithdrawRiskFactsReader, WithdrawRiskSubject } from './withdraw-risk-port.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

// The facts port lives in ./withdraw-risk-port.ts so the default reader (../infra) does not
// import this file back.
export type { WithdrawRiskFactsReader, WithdrawRiskSubject } from './withdraw-risk-port.ts';

export interface WithdrawRiskFlagsOptions {
  /** risk.withdraw.* thresholds, read on the W1 transaction. */
  readonly config: PayoutConfigPort;
  readonly logger: Pick<Logger, 'warn'>;
  /** ③ BR-ID-37, judged in the caller's transaction (B1-03k / B1-03n). */
  readonly sameDevice: SameDeviceAccountsCheck;
  /**
   * Absent: createWithdrawRiskFactsReader() without ports, whose ⑥ and ⑩ then fail (→
   * risk_calc_failed); production passes the reader with commission's and identity's ports.
   */
  readonly facts?: WithdrawRiskFactsReader;
}

export interface WithdrawRiskFlags {
  compute(trx: Transaction<DB>, subject: WithdrawRiskSubject): Promise<readonly WithdrawRiskFlag[]>;
}

/** What W1 (createWithdrawApply's options) takes to write the snapshot. */
export interface WithdrawApplyRiskOptions {
  riskFlags?: WithdrawRiskFlags;
}

/** 9.3 #6: the configuration keys of the six thresholds and their defaults (BR-WDR-29). */
export const WITHDRAW_RISK_CONFIG_KEYS: Readonly<Record<keyof WithdrawRiskThresholds, string>> = {
  invalid_ratio_bp: 'risk.withdraw.invalid_ratio_bp',
  invalid_min_count: 'risk.withdraw.invalid_min_count',
  high_commission_rate_bp: 'risk.withdraw.high_commission_rate_bp',
  high_commission_ratio_bp: 'risk.withdraw.high_commission_ratio_bp',
  min_orders: 'risk.withdraw.min_orders',
  withdraw_received_ratio_bp: 'risk.withdraw.withdraw_received_ratio_bp',
};

export const WITHDRAW_RISK_DEFAULTS: WithdrawRiskThresholds = {
  invalid_ratio_bp: 3000,
  invalid_min_count: 3,
  high_commission_rate_bp: 5000,
  high_commission_ratio_bp: 5000,
  min_orders: 5,
  withdraw_received_ratio_bp: 10000,
};

const THRESHOLD_NAMES = Object.keys(WITHDRAW_RISK_CONFIG_KEYS) as (keyof WithdrawRiskThresholds)[];
const SAVEPOINT = sql.raw('payout_withdraw_risk_item');
/** BR order ①②③④⑤⑥⑦⑧⑩ (risk_calc_failed follows). */
const WITHDRAW_RISK_FLAG_ORDER: readonly WithdrawRiskFlagCode[] = [
  'first_withdrawal',
  'credited_today',
  'same_device_multi_account',
  'invalid_ratio_60d',
  'high_commission_ratio_60d',
  'withdraw_vs_received',
  'had_negative',
  'recon_diff',
  'payee_prev_other_user',
];

/** A stored threshold: a non-negative safe integer, else unusable (the default applies). */
function thresholdOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function createWithdrawRiskFlags(options: WithdrawRiskFlagsOptions): WithdrawRiskFlags {
  const facts = options.facts ?? createWithdrawRiskFactsReader();
  const { config, logger, sameDevice } = options;

  /**
   * `work` under a savepoint: a failure (a failed statement or one thrown without any) rolls back
   * to it and answers `failed`; the transaction stays usable. A failure of the rollback itself (the
   * connection is gone) propagates.
   */
  async function isolated<V>(
    trx: Transaction<DB>,
    work: () => Promise<V>,
  ): Promise<{ ok: true; value: V } | { ok: false }> {
    await sql`SAVEPOINT ${SAVEPOINT}`.execute(trx);
    let value: V;
    try {
      value = await work();
    } catch {
      // The error may carry driver details or member data: never logged.
      await sql`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`.execute(trx);
      await sql`RELEASE SAVEPOINT ${SAVEPOINT}`.execute(trx);
      return { ok: false };
    }
    await sql`RELEASE SAVEPOINT ${SAVEPOINT}`.execute(trx);
    return { ok: true, value };
  }

  async function thresholds(trx: Transaction<DB>, appId: string): Promise<WithdrawRiskThresholds> {
    const result: Record<keyof WithdrawRiskThresholds, number> = { ...WITHDRAW_RISK_DEFAULTS };
    for (const name of THRESHOLD_NAMES) {
      const key = WITHDRAW_RISK_CONFIG_KEYS[name];
      const read = await isolated(trx, () => config.configValue(appId, key, trx));
      const value = read.ok && read.value !== null ? thresholdOf(read.value.value) : null;
      if (value !== null) {
        result[name] = value;
      } else if (!read.ok || read.value !== null) {
        // Unreadable or malformed (unset is the default silently): the key only, never the value.
        logger.warn({ app_id: appId, key }, 'withdraw_risk_threshold_default');
      }
    }
    return result;
  }

  return {
    async compute(trx, subject) {
      const limits = await thresholds(trx, subject.appId);
      const hits = new Map<WithdrawRiskFlagCode, WithdrawRiskFlag>();
      const failed = new Set<WithdrawRiskFlagCode>();
      /** One item: its labels when it ran, else every code it stands for goes to risk_calc_failed. */
      async function item(
        codes: readonly WithdrawRiskFlagCode[],
        work: () => Promise<readonly (WithdrawRiskFlag | null)[]>,
      ): Promise<void> {
        const run = await isolated(trx, work);
        if (!run.ok) {
          for (const code of codes) failed.add(code);
          return;
        }
        for (const flag of run.value) {
          if (flag !== null && flag.code !== 'risk_calc_failed') hits.set(flag.code, flag);
        }
      }
      const yes = (code: WithdrawRiskFlagCode): WithdrawRiskFlag => ({
        code,
        value: true,
        threshold: null,
      });

      await item(['first_withdrawal'], async () => [
        (await facts.hasPaidWithdrawal(trx, subject)) ? null : yes('first_withdrawal'),
      ]);
      await item(['credited_today'], async () => [
        (await facts.creditedToday(trx, subject)) ? yes('credited_today') : null,
      ]);
      await item(['same_device_multi_account'], async () => {
        const judged = await sameDevice.judge(trx, {
          app_id: subject.appId,
          user_id: subject.userId,
          ref: { type: 'withdrawal', id: subject.withdrawalId },
        });
        return [judged.marked ? yes('same_device_multi_account') : null];
      });
      await item(['invalid_ratio_60d', 'high_commission_ratio_60d'], async () => {
        const orders: readonly SelfOrderFact[] = await facts.selfOrders60d(trx, subject);
        return [
          invalidRatioFlag(
            { orders: orders.length, invalid: orders.filter((order) => order.invalid).length },
            limits,
          ),
          highCommissionRatioFlag(orders, limits),
        ];
      });
      await item(['withdraw_vs_received'], async () => {
        const withdrawn = await facts.withdrawn30dFen(trx, subject);
        const received = await facts.received60dFen(trx, subject);
        return [
          withdrawVsReceivedFlag(
            { withdrawn_fen: addFen(withdrawn, subject.amountFen), received_fen: received },
            limits,
          ),
        ];
      });
      await item(['had_negative'], async () => [
        (await facts.hadNegative(trx, subject)) ? yes('had_negative') : null,
      ]);
      await item(['recon_diff'], async () => [
        (await facts.reconDiff(trx, subject)) ? yes('recon_diff') : null,
      ]);
      await item(['payee_prev_other_user'], async () => [
        (await facts.payeePrevOtherUser(trx, subject)) ? yes('payee_prev_other_user') : null,
      ]);

      const flags: WithdrawRiskFlag[] = [];
      const failedCodes: WithdrawRiskFlagCode[] = [];
      for (const code of WITHDRAW_RISK_FLAG_ORDER) {
        const hit = hits.get(code);
        if (hit !== undefined) flags.push(hit);
        if (failed.has(code)) failedCodes.push(code);
      }
      if (failedCodes.length > 0) {
        logger.warn(
          { app_id: subject.appId, withdrawal_id: subject.withdrawalId, codes: failedCodes },
          'withdraw_risk_calc_failed',
        );
        flags.push({ code: 'risk_calc_failed', value: failedCodes, threshold: null });
      }
      return flags;
    },
  };
}
