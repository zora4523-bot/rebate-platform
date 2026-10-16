// POST /v1/me/phone, first binding (规划/04 §6.1; 08 BR-ID-06; task B1-20a, orchestrator ruling §9.3).
// NotImplemented skeleton written with the rule tests (test/spec/identity/bind-phone/**). The
// rule tests pin AccountAssetsPort and the IdentityModule.forRoot option `accountAssets` (they
// wrap the assembled port); the service shape below is a starting point the implementation may
// adapt (for instance to run inside the idempotency transaction).
//
// Order of a first binding (the account has no phone_hmac): normalize_phone → 20001 phone_invalid
// (no code consumed) → SmsCodeService.verifyAndConsume(purpose=bind) → 20002 / 20003 → the phone
// blocklist → 44001 (code consumed) → the number belongs to another account of the app
// (status <> 'deleted', a deleting account included) → 30411 → otherwise phone_cipher and
// phone_hmac (normalised number) are written by a conditional update (phone_hmac IS NULL), inside
// the idempotency transaction. An account that already has a phone (a change) answers 10003 in
// this task, with or without X-Step-Up-Token, before any code is consumed (B1-20b does changes).
//
// 30411 carries data.reason=mergeable and data.merge_ticket only when all of these hold:
// the account registered with wechat / apple / huawei and has no phone; AccountAssetsPort reports
// no order, no claim and no ledger entry; parent_id is null and no user has it as parent; the
// target account is status 'normal', is not banned (readRiskState fresh; appealing after banned
// counts as banned) and has no user_oauth row of a provider the account itself has. The ticket
// (at least 128 random bits) is stored in Redis namespace `merge_ticket`, key the SHA-256 hex of
// the ticket, value JSON {app_id, uid, phone_hmac}, 300 seconds; Redis unavailable → 50001.
// Nothing logs a phone number, a code or a ticket.
//
// AccountAssetsPort is assembled by app.module and handed to IdentityModule.forRoot as the option
// `accountAssets` (a factory provider, like `blocklist`): countOrders is a read-only count of
// app.orders rows of the user (any status); hasClaims and hasLedgerEntries answer false until the
// claim and ledger modules exist (TODO lines in app.module). B1-02z's invite backfill shares it.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, FieldCrypto, RedisHandle, RootLogger } from '../../platform/index.ts';
import type { BlocklistService, RiskStateService } from '../../risk/index.ts';
import type { SmsCodeService } from './sms-codes.ts';

/** One account of one app. */
export interface AccountRef {
  readonly app_id: string;
  readonly user_id: string;
}

/**
 * Read-only footprint of an account outside identity (BR-ID-06 merge conditions), assembled by
 * app.module (IdentityModule.forRoot option `accountAssets`). `db` is the caller's executor.
 */
export interface AccountAssetsPort {
  /** Rows of app.orders whose user_id is the account, whatever their status. */
  countOrders(db: Kysely<DB>, account: AccountRef): Promise<number>;
  /** True when the account has any order claim (找回申请); false until B1-10 exists. */
  hasClaims(db: Kysely<DB>, account: AccountRef): Promise<boolean>;
  /** True when the account's balance has any ledger entry; false until the ledger exists. */
  hasLedgerEntries(db: Kysely<DB>, account: AccountRef): Promise<boolean>;
}

/** The verified request: uid, app and device come from the token and the signed device only. */
export interface BindPhoneCommand {
  readonly app_id: string;
  readonly user_id: string;
  readonly device_id: string;
  readonly body: { readonly phone: string; readonly code: string };
}

export type BindPhoneResult =
  | { readonly code: 0 }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly ['phone']; readonly reason: 'phone_invalid' };
    }
  | { readonly code: 20002 }
  | { readonly code: 20003 }
  | { readonly code: 44001; readonly data?: { readonly risk_msg_code: string } }
  | {
      readonly code: 30411;
      readonly data?: { readonly reason: 'mergeable'; readonly merge_ticket: string };
    }
  | { readonly code: 10003 }
  | { readonly code: 50001 };

export interface BindPhoneOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly redis: RedisHandle;
  readonly logger: RootLogger;
  readonly sms: Pick<SmsCodeService, 'verifyAndConsume'>;
  readonly blocklist: BlocklistService | null;
  readonly riskState: Pick<RiskStateService, 'readRiskState'>;
  readonly assets: AccountAssetsPort;
}

export interface BindPhoneService {
  bind(command: BindPhoneCommand): Promise<BindPhoneResult>;
}

export function createBindPhoneService(options: BindPhoneOptions): BindPhoneService {
  void options;
  throw new Error('NotImplemented: createBindPhoneService');
}
