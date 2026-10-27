// B2-11c: the automatic payout decision of 规划/08 BR-WDR-30 as the worker's withdrawal.created
// consumer (consumer payout-auto-payout, queue evt.payout-auto-payout; events/types.ts and
// queue/catalog.ts register them). Each withdrawal is judged once:
//   review_mode already set      nothing (B2-05d: switch off at W1 → manual; a decision was made).
//   locks                        identity's users row → ledger.lockBalances → the advisory lock
//                                pg_advisory_xact_lock('auto_payout_daily'), inside which ⑦ (review_mode
//                                auto, status ∉ {REJECTED, FAILED}, reviewed_at in the current +08:00
//                                day / month; payee by payee_hmac across members, member by user_id)
//                                and ⑨ (Σ amount_fen of the same rows today, this one included) are read.
//   inputs                       ⑤ active withdraw_holds or risk_state ∈ {frozen, appealing} or
//                                frozen_fen > amount_fen; ⑥ ⑧ with t = created_at (B2-11a's facts
//                                reader); ⑩ adult; ⑪ payout.channel_enabled.<channel of the snapshot>;
//                                ⑫ risk_flags ∩ risk_block_flags and the live blacklist_hit; ⑬ no
//                                withdrawal block, available_fen ≥ 0, blocked_reason null; then
//                                decideAutoPayout (B2-11b) compares.
//   write                        auto_decision {result, failed_conditions, warn_values, rule_version,
//                                decided_at} and review_mode.
//   manual                       review_deadline = created_at + 24 working hours (BR-WDR-26).
//   auto                         system W2 through B2-05e's approve (CAS status = PENDING_REVIEW,
//                                reviewer_id null) → executeBatch with executor 'system:auto_payout'
//                                (one kind=auto batch of this withdrawal, B2-06c); EXECUTE refused or
//                                the withdrawal left out → stays APPROVED, auto_decision gets
//                                execute_blocked with the reason. The CAS matching nothing (a human
//                                reviewed first) ends the consumer: only auto_decision is written.
//   alert                        today's automatic total reaching 80% of platform_daily_max_fen
//                                (BR-WDR-24): logger.warn(…, 'auto_payout_daily_near_cap').
// processed_events claim and every effect commit in one transaction (consume), as went-negative.ts.
// Rule tests: test/spec/payout/auto-payout/**, test/properties/domain/payout/auto-payout-once.ts.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { ReceivedEvent } from '../../platform/index.ts';
import type { AppealPrevStateReader, RiskStateBatchReader } from '../../risk/index.ts';
import type { AutoPayoutDecision } from '../domain/auto-decision.ts';
import type { PayoutBatchRejectReason, PayoutExecute, PayoutLeftReason } from './payout-execute.ts';
import type { WithdrawRiskFactsReader } from './withdraw-risk-port.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';
import type { WithdrawalCommandsOptions } from './withdrawal-commands.ts';

/** ⑩ identity's BR-ID-26 adult_at: the member is 18 or older at `at`. */
export interface AutoPayoutAdultReader {
  isAdult(handle: Kysely<DB>, input: { appId: string; userId: string; at: Date }): Promise<boolean>;
}

/** ⑫ BR-WDR-29 ⑨ blacklist_hit, checked live at the decision (never from the W1 snapshot). */
export interface AutoPayoutBlacklistReader {
  hit(
    handle: Kysely<DB>,
    input: { appId: string; userId: string; payeeHmac: string },
  ): Promise<boolean>;
}

/** Why an automatic withdrawal stayed APPROVED: the batch refusal or the member's left reason. */
export type AutoPayoutExecuteBlocked = PayoutBatchRejectReason | PayoutLeftReason;

/** withdrawals.auto_decision (BR-WDR-30 可追溯). */
export interface AutoPayoutDecisionRecord extends AutoPayoutDecision {
  /** The configuration group's version, increased on every save. */
  rule_version: number;
  /** The Clock instant of the decision, ISO 8601. */
  decided_at: string;
  execute_blocked?: AutoPayoutExecuteBlocked;
}

export interface AutoPayoutOptions extends WithdrawalCommandsOptions {
  db: Kysely<DB>;
  logger: { warn(fields: Record<string, unknown>, message: string): void };
  /** content's configuration reader: withdraw.auto_payout.*, payout.channel_enabled.*, calendar.*. */
  config: PayoutConfigPort;
  /** ⑤ ⑬ risk_state. */
  risk: RiskStateBatchReader;
  /** ⑬ appealing over frozen / banned. */
  appeal: AppealPrevStateReader;
  /** ④ ⑥ ⑧ (B2-11a's reader), read with t = created_at. */
  facts: WithdrawRiskFactsReader;
  adult: AutoPayoutAdultReader;
  blacklist: AutoPayoutBlacklistReader;
  /** B2-06c's EXECUTE. */
  execute: Pick<PayoutExecute, 'executeBatch'>;
}

export interface AutoPayoutConsumer {
  /** Own transaction; processed_events claim and the decision's effects commit together. */
  consume(event: ReceivedEvent): Promise<void>;
  /** The handler registerEventConsumer runs inside its claim transaction (worker wiring). */
  handle(event: ReceivedEvent, trx: Transaction<DB>): Promise<void>;
}

export function createAutoPayoutConsumer(options: AutoPayoutOptions): AutoPayoutConsumer {
  void options;
  throw new Error('NotImplemented: createAutoPayoutConsumer');
}
