// The sources of a personal information copy (规划/08 BR-ID-40 细则「导出范围（默认）」; 规划/04 §3.2
// personal_data_copies; task B1-27f). The generation job (B1-27h) reads each section through this
// port and only serialises and packs what it gets; nothing here writes, caches or logs.
//
// Every read takes the caller's handle (a READ ONLY transaction included) and the subject
// (app_id, user_id): it runs plain SELECTs on that handle (no locking clause, no second
// connection), scoped by app_id and by the user, and returns only the user's own data — never
// another person's (BR-ID-40 「不含他人信息」):
//   account      nickname, the bound phone in full (the user's own; the copy carries it, BR-ID-40
//                细则「企业微信会话交付的下载」), the providers of the user's third-party logins, the
//                registration time (users.created_at); null when the user does not exist.
//   realname     masked only (BR-ID-33: name **三, ID number 1****************X); never the name,
//                the ID number or the birth date in clear. No record → status none and nulls.
//   consents     the user's own consent records (subject_type user); device-subject records are
//                the installation's, possibly another person's, and are left out.
//   orders       the user's orders (orders.user_id), whatever their age.
//   ledger       the entries of the user's own balance account only (not the platform's
//                counter-entries of the same voucher).
//   withdrawals  the user's withdrawals with the payee account masked (BR-ID-33 收款账号); never
//                the account or the payee name in clear, nor the console staff who handled them.
//   agent        the user's Agent conversations not yet past their retention (BR-ID-30 ①, 190
//                days), with their messages in order; guest sessions of the same device are not
//                the user's and are left out; no report handling by the console staff.
//   invite       only whether an inviter is bound (BR-ID-40, J7): nothing of the inviter or of
//                the user's invitees.
// identity implements account / realname / consents itself (createPersonalDataCopySources); the
// other sections are the owners' read-only files (orders / ledger / payout / agent / growth
// application/personal-data-copy-read.ts, through their index.ts), assembled by app.module.
// Amounts are bigint fen and instants are Date: serialisation belongs to B1-27h.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface PersonalDataCopySubject {
  readonly appId: string;
  readonly userId: string;
}

/** One section's read, on the caller's handle; never writes. */
export type PersonalDataCopyRead<T> = (
  handle: Kysely<DB>,
  subject: PersonalDataCopySubject,
) => Promise<T>;

export interface PersonalDataCopyAccount {
  readonly nickname: string;
  /** The bound phone in full; null when no phone is bound. */
  readonly phone: string | null;
  /** 第三方登录方式: the providers of the user's third-party bindings (wechat, apple, huawei). */
  readonly login_providers: readonly string[];
  readonly registered_at: Date;
}

export interface PersonalDataCopyRealname {
  readonly status: 'none' | 'verified' | 'failed';
  readonly masked_name: string | null;
  readonly masked_id_no: string | null;
  readonly verified_at: Date | null;
}

export interface PersonalDataCopyConsent {
  readonly type: string;
  readonly version: number;
  readonly channel: string;
  readonly accepted: boolean;
  readonly client_at: Date;
  readonly server_at: Date;
}

export interface PersonalDataCopyOrder {
  readonly order_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly title: string | null;
  readonly pay_amount_fen: bigint | null;
  readonly platform_status: string;
  readonly rebate_status: string;
  readonly paid_at: Date | null;
  readonly created_at: Date;
}

export interface PersonalDataCopyLedgerEntry {
  readonly ledger_type: string;
  readonly sub_type: string | null;
  readonly sub_account: 'available' | 'frozen';
  readonly amount_fen: bigint;
  readonly balance_after_fen: bigint | null;
  readonly booked_at: Date;
}

export interface PersonalDataCopyWithdrawal {
  readonly withdrawal_id: string;
  readonly status: string;
  readonly amount_fen: bigint;
  readonly fee_fen: bigint;
  readonly tax_fen: bigint;
  readonly net_fen: bigint;
  readonly payout_channel: string;
  /** BR-ID-33 收款账号: 138****5678, zh***@example.com, 尾号 1234. */
  readonly masked_account: string;
  readonly created_at: Date;
  readonly paid_at: Date | null;
}

export interface PersonalDataCopyAgentMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string | null;
  readonly created_at: Date;
}

export interface PersonalDataCopyAgentConversation {
  readonly session_id: string;
  readonly started_at: Date;
  readonly last_active_at: Date;
  /** Oldest first. */
  readonly messages: readonly PersonalDataCopyAgentMessage[];
}

export interface PersonalDataCopyInvite {
  readonly has_inviter: boolean;
}

export interface PersonalDataCopySources {
  readonly account: PersonalDataCopyRead<PersonalDataCopyAccount | null>;
  readonly realname: PersonalDataCopyRead<PersonalDataCopyRealname>;
  readonly consents: PersonalDataCopyRead<readonly PersonalDataCopyConsent[]>;
  readonly orders: PersonalDataCopyRead<readonly PersonalDataCopyOrder[]>;
  readonly ledger: PersonalDataCopyRead<readonly PersonalDataCopyLedgerEntry[]>;
  readonly withdrawals: PersonalDataCopyRead<readonly PersonalDataCopyWithdrawal[]>;
  readonly agent: PersonalDataCopyRead<readonly PersonalDataCopyAgentConversation[]>;
  readonly invite: PersonalDataCopyRead<PersonalDataCopyInvite>;
}
