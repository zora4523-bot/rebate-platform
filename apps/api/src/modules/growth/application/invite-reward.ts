import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';
import type { SameDeviceAccountsCheck } from '../../risk/index.ts';
import type { InviteBinderDeps } from './invite-binder.ts';

export interface InviteRewardOrder {
  app_id: string;
  order_id: string;
  user_id: string | null;
  buy_type: string | null;
  base_fen: bigint | null;
  pay_amount_fen: bigint | null;
  attr_at: Date;
  credited_at: Date | null;
  rebate_status: string;
  refunded_quantity: number | null;
  refunded_quantity_at_credit: number | null;
  rights_pending: boolean;
  has_rights: boolean;
}

export interface InviteRewardOrderFacts {
  read(
    trx: Transaction<DB>,
    input: { app_id: string; order_id: string },
  ): Promise<InviteRewardOrder | null>;
  listSelfOrdersInWindow(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; from: Date; to: Date },
  ): Promise<readonly InviteRewardOrder[]>;
}

export interface InviteRewardGrantInput {
  app_id: string;
  invitee_id: string;
  party: 'inviter' | 'invitee';
  user_id: string;
  amount_fen: bigint;
  at: Date;
}

/** B2-16b supplies this transactional, idempotent REWARD/sub_type=invite writer. */
export interface InviteRewardGrantWriter {
  grant(trx: Transaction<DB>, input: InviteRewardGrantInput): Promise<{ voucher_id: string }>;
}

export interface InviteRewardBaseDeps {
  db: Kysely<DB>;
  config: InviteBinderDeps['config'];
  clock: Clock;
  logger: RootLogger;
}

export interface InviteRewardQualificationInput {
  app_id: string;
  invitee_id: string;
  inviter_id: string;
  bind_source: 'register' | 'backfill' | 'landing' | 'admin';
  client_ip: string;
  at: Date;
}

export interface InviteRewardQualifier {
  qualifyInviteReward(trx: Transaction<DB>, input: InviteRewardQualificationInput): Promise<void>;
}

export function createInviteRewardQualifier(
  deps: InviteRewardBaseDeps & { crypto: Pick<FieldCrypto, 'blindIndex'> },
): InviteRewardQualifier {
  void deps;
  throw new Error('NotImplemented: createInviteRewardQualifier');
}

export function createInviteRewardBudgetReader(deps: Pick<InviteRewardBaseDeps, 'db' | 'config'>): {
  available(appId: string): Promise<number | null>;
} {
  void deps;
  throw new Error('NotImplemented: createInviteRewardBudgetReader');
}

export interface InviteRewardTrigger {
  onCredited(trx: Transaction<DB>, input: { app_id: string; order_id: string }): Promise<void>;
}

export function createInviteRewardTrigger(
  deps: InviteRewardBaseDeps & { orders: InviteRewardOrderFacts },
): InviteRewardTrigger {
  void deps;
  throw new Error('NotImplemented: createInviteRewardTrigger');
}

export interface InviteRewardLoginIps {
  read(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; from: Date; to: Date },
  ): Promise<readonly string[]>;
}

export interface InviteRewardDeletedPhone {
  retained(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; at: Date },
  ): Promise<boolean>;
}

export interface InviteRewardPayoutDeps extends InviteRewardBaseDeps {
  orders: InviteRewardOrderFacts;
  crypto: Pick<FieldCrypto, 'blindIndex'>;
  loginDevices: InviteBinderDeps['loginDevices'];
  loginIps: InviteRewardLoginIps;
  deletedPhone: InviteRewardDeletedPhone;
  // TODO(规划/11 §2.3): cooling — blocked on B1-15
  deletionStatus: {
    read(
      trx: Kysely<DB>,
      input: { app_id: string; user_ids: readonly string[] },
    ): Promise<ReadonlyMap<string, 'none' | 'processing' | 'done'>>;
  };
  readRisk: InviteBinderDeps['readRisk'];
  verifiedBirthDate?: InviteBinderDeps['verifiedBirthDate'];
  multiAccount: SameDeviceAccountsCheck;
  grantWriter?: InviteRewardGrantWriter;
}

export type InviteRewardProcessResult =
  'ignored' | 'processed' | 'voided' | 'deferred_budget' | 'deferred_paused' | 'deferred_writer';

export interface InviteRewardPayout {
  process(appId: string, inviteeId: string): Promise<InviteRewardProcessResult>;
}

export function createInviteRewardPayout(deps: InviteRewardPayoutDeps): InviteRewardPayout {
  void deps;
  throw new Error('NotImplemented: createInviteRewardPayout');
}

export interface InviteRewardExpiry {
  expireIfDue(appId: string, inviteeId: string): Promise<void>;
}

export function createInviteRewardExpiry(
  deps: InviteRewardBaseDeps & { orders: InviteRewardOrderFacts },
): InviteRewardExpiry {
  void deps;
  throw new Error('NotImplemented: createInviteRewardExpiry');
}

/** worker calls tick every 60 seconds; expiry runs on the first tick and each accounting day. */
export interface InviteRewardScanner {
  tick(): Promise<void>;
}

export function createInviteRewardScanner(
  deps: Pick<InviteRewardBaseDeps, 'db' | 'clock' | 'logger'> & {
    payout: InviteRewardPayout;
    expiry: InviteRewardExpiry;
  },
): InviteRewardScanner {
  void deps;
  throw new Error('NotImplemented: createInviteRewardScanner');
}

export function startInviteRewardWorker(deps: {
  scanner: InviteRewardScanner;
  logger: RootLogger;
}): { stop(): Promise<void> } {
  void deps;
  throw new Error('NotImplemented: startInviteRewardWorker');
}
