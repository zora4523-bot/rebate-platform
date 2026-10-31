// B2-08d rule-test kit (claude-independent, SPEC_REF 9ab94dc0): the quarterly tax export port of
// payout (规划/08 BR-WDR-21 涉税导出与报送; task §9). Real pieces: PostgreSQL through
// @couli/db/testing (couli_app; apply/kit.ts's open / close / seedUser). Synthetic: members, their
// withdrawals (direct INSERT as read-port/kit.ts, every payee value made up), and the decryption
// port (cipher = "cipher:" + the account in clear, so the masking input is known).
// Only *.int.test.ts files call the database parts; the reader under test is created inside each
// test before anything is seeded: red is the skeleton's NotImplemented.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely, Selectable } from 'kysely';
import { seedUser } from '../apply/kit.ts';

export { open, close, seedUser, TIMEOUT } from '../apply/kit.ts';
export type { Harness } from '../apply/kit.ts';

export type WithdrawalRow = Selectable<DB['withdrawals']>;
export type Channel = 'alipay' | 'bank_card' | 'wechat';

/** The only income type (BR-WDR-20, BR-FUND-13). */
export const SERVICE_FEE = 'SERVICE_FEE';
/** Default page size and the cap (task §9.1). */
export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;

/** The row keys of the port, sorted (task §9.1: nine fields, nothing else). */
export const ROW_KEYS = [
  'amount_fen',
  'income_type',
  'masked_account',
  'out_biz_no',
  'paid_at',
  'payout_channel',
  'tax_fen',
  'user_id',
  'withdrawal_id',
] as const;

/** Synthetic payee values; none may leave the port. */
export const PAYEE_NAME = '合成收款人乙';
export const BANK_NAME = '合成税务测试银行';
export const ALIPAY_PHONE = '13800135678';
export const ALIPAY_PHONE_MASKED = '138****5678';
export const ALIPAY_EMAIL = 'zhangsan.synthetic@example.test';
export const ALIPAY_EMAIL_MASKED = 'zh***@example.test';
export const BANK_CARD = '6222000011112222333';
export const BANK_CARD_MASKED = '尾号 2333';
export const WECHAT_OPENID = 'o_synthetic_openid_1';
export const WECHAT_MASKED = '*'.repeat(WECHAT_OPENID.length);

/** The account in clear seeded for a channel by default. */
export function defaultAccount(channel: Channel): string {
  if (channel === 'alipay') return ALIPAY_PHONE;
  if (channel === 'bank_card') return BANK_CARD;
  return WECHAT_OPENID;
}

const CIPHER_PREFIX = 'cipher:';

export function cipherOf(plain: string): Buffer {
  return Buffer.from(`${CIPHER_PREFIX}${plain}`, 'utf8');
}

export interface DecryptCall {
  readonly cipher: string;
  readonly method: string;
}

/** The decryption port (DecryptWithdrawalAccount) over the synthetic ciphers, recording its calls. */
export function fakeDecrypt() {
  const calls: DecryptCall[] = [];
  const decrypt = (cipher: Buffer, method: string): string => {
    const text = Buffer.from(cipher).toString('utf8');
    calls.push({ cipher: text, method });
    if (!text.startsWith(CIPHER_PREFIX)) throw new Error('fakeDecrypt: not a synthetic cipher');
    return text.slice(CIPHER_PREFIX.length);
  };
  return { decrypt, calls };
}

/** A fresh app with one member. */
export async function member(db: Kysely<DB>, appId = `tx_${randomUUID()}`) {
  return { appId, userId: await seedUser(db, appId) };
}

export interface Who {
  readonly appId: string;
  readonly userId: string;
}

type Patch = Partial<Insertable<DB['withdrawals']>> & {
  readonly payout_channel?: Channel;
  /** The account in clear behind payee_account_cipher (default by channel). */
  readonly account?: string;
};

/** The INSERT values of one synthetic withdrawal (status default PAID_API). */
export function withdrawalValues(who: Who, patch: Patch = {}): Insertable<DB['withdrawals']> {
  const { account, ...rest } = patch;
  const channel: Channel = rest.payout_channel ?? 'alipay';
  const status = rest.status ?? 'PAID_API';
  const amount = rest.amount_fen ?? 12_345n;
  const fee = rest.fee_fen ?? 123n;
  const tax = rest.tax_fen ?? 456n;
  const paid = status === 'PAID_API' || status === 'PAID_MANUAL';
  const createdAt = new Date('2026-10-02T01:02:03.456Z');
  return {
    id: randomUUID(),
    app_id: who.appId,
    user_id: who.userId,
    amount_fen: amount,
    fee_fen: fee,
    tax_fen: tax,
    net_fen: amount - fee - tax,
    income_type: SERVICE_FEE,
    payout_method: channel,
    payout_channel: channel,
    payee_name: PAYEE_NAME,
    payee_account_cipher: cipherOf(account ?? defaultAccount(channel)),
    payee_hmac: randomBytes(32).toString('hex'),
    bank_name: channel === 'bank_card' ? BANK_NAME : null,
    wechat_app_id: channel === 'wechat' ? 'wx_synthetic_app' : null,
    status,
    out_biz_no: randomBytes(16).toString('hex'),
    reject_reason_code: status === 'REJECTED' ? 'USER_REQUEST' : null,
    fail_code: status === 'FAILED' ? 'PAYEE_NOT_EXIST' : null,
    paid_at: paid ? new Date('2026-10-15T04:00:00.000Z') : null,
    channel_order_id: paid ? `synthetic_${randomBytes(8).toString('hex')}` : null,
    manual_entry_by: status === 'PAID_MANUAL' ? randomUUID() : null,
    manual_confirm_by: status === 'PAID_MANUAL' ? randomUUID() : null,
    created_at: createdAt,
    updated_at: createdAt,
    ...rest,
  };
}

/** One synthetic withdrawal, as stored. */
export async function seedWithdrawal(
  db: Kysely<DB>,
  who: Who,
  patch: Patch = {},
): Promise<WithdrawalRow> {
  return db
    .withSchema('app')
    .insertInto('withdrawals')
    .values(withdrawalValues(who, patch))
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Many synthetic withdrawals in one INSERT, as stored. */
export async function seedMany(
  db: Kysely<DB>,
  who: Who,
  patches: readonly Patch[],
): Promise<WithdrawalRow[]> {
  if (patches.length === 0) return [];
  return db
    .withSchema('app')
    .insertInto('withdrawals')
    .values(patches.map((patch) => withdrawalValues(who, patch)))
    .returningAll()
    .execute();
}

/** The masked account expected for a stored row whose clear account is `plain`. */
export function maskedOf(channel: Channel, plain: string): string {
  if (channel === 'alipay') {
    if (plain === ALIPAY_PHONE) return ALIPAY_PHONE_MASKED;
    if (plain === ALIPAY_EMAIL) return ALIPAY_EMAIL_MASKED;
  }
  if (channel === 'bank_card' && plain === BANK_CARD) return BANK_CARD_MASKED;
  if (channel === 'wechat' && plain === WECHAT_OPENID) return WECHAT_MASKED;
  throw new Error(`maskedOf: no expected mask for ${channel} ${plain}`);
}

/** The row the port must return for a stored withdrawal whose clear account is `plain`. */
export function expectedRow(
  row: WithdrawalRow,
  plain = defaultAccount(row.payout_channel as Channel),
) {
  if (row.paid_at === null) throw new Error('expectedRow: the row is not paid');
  return {
    withdrawal_id: row.id,
    user_id: row.user_id,
    income_type: SERVICE_FEE,
    amount_fen: row.amount_fen,
    tax_fen: row.tax_fen,
    paid_at: row.paid_at,
    masked_account: maskedOf(row.payout_channel as Channel, plain),
    out_biz_no: row.out_biz_no,
    payout_channel: row.payout_channel,
  };
}

/** Rows in the port's order: paid_at ASC, then id ASC (uuid order = lowercase hex order). */
export function inExportOrder<T extends { readonly paid_at: Date | null; readonly id: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const at = (a.paid_at?.getTime() ?? 0) - (b.paid_at?.getTime() ?? 0);
    if (at !== 0) return at;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/** The ids of a page's items. */
export function ids(items: readonly { readonly withdrawal_id: string }[]): string[] {
  return items.map((item) => item.withdrawal_id);
}

/** Everything the port could have touched for one app. */
export async function footprint(db: Kysely<DB>, appId: string) {
  const app = db.withSchema('app');
  return {
    withdrawals: await app
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    entries: await app
      .selectFrom('ledger_entries')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    events: await app
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    tax: await app
      .selectFrom('tax_ytd')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}

/** JSON text of a value (bigint as text), for "never in the output" checks. */
export function serialise(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}
