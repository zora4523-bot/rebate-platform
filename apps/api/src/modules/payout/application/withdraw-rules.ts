import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock } from '../../platform/index.ts';
import type {
  AppealPrevStateReader,
  BlocklistMatchReader,
  RiskStateBatchReader,
} from '../../risk/index.ts';
import type { WithdrawBlock, WithdrawLimits, WithdrawUsage } from '../domain/withdraw-rules.ts';

export interface WithdrawActor {
  appId: string;
  userId: string;
  deviceId: string;
}

export interface PayoutConfigPort {
  configValue(
    appId: string,
    key: string,
    handle: Kysely<DB>,
  ): Promise<{ value: unknown; version: number } | null>;
}

export interface ReverifyGatePort {
  check(
    handle: Kysely<DB>,
    subject: WithdrawActor,
  ): Promise<{ code: number; data: { method: string } } | null>;
}

export interface WithdrawHold {
  reason: 'manual' | 'recon_diff' | 'ledger_mismatch' | 'manual_failed_watch';
  released_at: Date | null;
  hold_until: Date | null;
}

export interface WithdrawUsageReader {
  read(
    handle: Kysely<DB>,
    input: WithdrawActor & { payeeHmac: string | null; now: Date },
  ): Promise<WithdrawUsage>;
}

export interface FeeTaxCalculator {
  calculate(
    handle: Kysely<DB>,
    input: WithdrawActor & { amountFen: bigint; now: Date },
  ): Promise<{
    fee_fen: bigint;
    tax_fen: bigint;
    net_fen: bigint;
  }>;
}

export interface WithdrawRulesOptions {
  clock: Clock;
  logger: Pick<Logger, 'warn'>;
  config: PayoutConfigPort;
  risk: RiskStateBatchReader;
  appeal: AppealPrevStateReader;
  blocklist: BlocklistMatchReader;
  reverify: ReverifyGatePort;
  /** Structural ports keep Nest's decorated identity controllers out of pure consumers. */
  realname: {
    read(
      handle: Kysely<DB>,
      subject: { app_id: string; user_id: string },
    ): Promise<'none' | 'verified' | 'failed'>;
    verified(
      handle: Kysely<DB>,
      subject: { app_id: string; user_id: string },
    ): Promise<{
      name: string;
      birth_date: string;
      provider: string;
      verified_at: Date;
    } | null>;
  };
  subject: {
    read(
      handle: Kysely<DB>,
      subject: { appId: string; userId: string },
    ): Promise<{
      payout_method: 'alipay' | 'bank_card' | 'wechat';
      payee_name: string;
      payee_hmac: string;
    } | null>;
  };
  laborAgreementSigned(
    handle: Kysely<DB>,
    subject: { app_id: string; user_id: string },
  ): Promise<boolean>;
  ledger: Pick<Ledger, 'getBalances'>;
  holds: { read(handle: Kysely<DB>, subject: WithdrawActor): Promise<readonly WithdrawHold[]> };
  usage: WithdrawUsageReader;
  selfPurchase: {
    read(
      handle: Kysely<DB>,
      input: WithdrawActor & { now: Date },
    ): Promise<{ count: number; amount_fen: bigint }>;
  };
  feeTax: FeeTaxCalculator;
}

export interface WithdrawRulesService {
  getRules(
    handle: Kysely<DB>,
    actor: WithdrawActor,
    amountFen?: bigint,
  ): Promise<components['schemas']['WithdrawRules']>;
  validate(
    handle: Kysely<DB>,
    actor: WithdrawActor,
    amountFen: bigint,
    stepUpValid: boolean,
  ): Promise<WithdrawBlock | null>;
}

export function readWithdrawLimits(
  handle: Kysely<DB>,
  actor: WithdrawActor,
  options: Pick<WithdrawRulesOptions, 'config' | 'logger'>,
): Promise<WithdrawLimits> {
  void handle;
  void actor;
  void options;
  throw new Error('NotImplemented: readWithdrawLimits');
}

export function createWithdrawRules(options: WithdrawRulesOptions): WithdrawRulesService {
  void options;
  throw new Error('NotImplemented: createWithdrawRules');
}

export function createDefaultFeeTaxCalculator(): FeeTaxCalculator {
  throw new Error('NotImplemented: createDefaultFeeTaxCalculator');
}
