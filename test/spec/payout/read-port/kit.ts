// B2-05l fixtures. Only *.int.test.ts provisions PG (via @couli/db/testing, in the orchestrator's
// container). Withdrawals are seeded by a direct INSERT (the seedWithdrawal / seedRecord pattern of
// the other payout rule tests); every payee value is synthetic.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely, Selectable } from 'kysely';
import { seedUser } from '../apply/kit.ts';

export { open, close, seedUser, TIMEOUT } from '../apply/kit.ts';
export type { Harness } from '../apply/kit.ts';

export { VIEW_KEYS, PRIVATE_KEYS } from './fields.ts';

export const PAYEE_NAME = '合成收款人甲';
export const BANK_NAME = '合成测试银行';
export const ACCOUNT_PLAIN = 'synthetic.payee@example.test';

export type WithdrawalRow = Selectable<DB['withdrawals']>;
type Channel = 'alipay' | 'bank_card' | 'wechat';

export async function member(db: Kysely<DB>, appId = `rp_${randomUUID()}`) {
  return { appId, userId: await seedUser(db, appId) };
}

export async function seedWithdrawal(
  db: Kysely<DB>,
  who: { appId: string; userId: string },
  patch: Partial<Insertable<DB['withdrawals']>> & { payout_channel?: Channel } = {},
): Promise<WithdrawalRow> {
  const channel: Channel = patch.payout_channel ?? 'alipay';
  const status = patch.status ?? 'PENDING_REVIEW';
  const amount = patch.amount_fen ?? 12345n;
  const fee = patch.fee_fen ?? 123n;
  const tax = patch.tax_fen ?? 45n;
  return db
    .withSchema('app')
    .insertInto('withdrawals')
    .values({
      id: randomUUID(),
      app_id: who.appId,
      user_id: who.userId,
      amount_fen: amount,
      fee_fen: fee,
      tax_fen: tax,
      net_fen: amount - fee - tax,
      income_type: 'SERVICE_FEE',
      payout_method: channel,
      payout_channel: channel,
      payee_name: PAYEE_NAME,
      payee_account_cipher: Buffer.from(`cipher:${ACCOUNT_PLAIN}`),
      payee_hmac: randomBytes(32).toString('hex'),
      bank_name: channel === 'bank_card' ? BANK_NAME : null,
      wechat_app_id: channel === 'wechat' ? 'wx_synthetic_app' : null,
      status,
      out_biz_no: randomBytes(16).toString('hex'),
      reject_reason_code: status === 'REJECTED' ? 'USER_REQUEST' : null,
      reject_note: status === 'REJECTED' ? '内部备注（合成）' : null,
      fail_code: null,
      paid_at: null,
      manual_entry_by: status === 'PAID_MANUAL' ? randomUUID() : null,
      manual_confirm_by: status === 'PAID_MANUAL' ? randomUUID() : null,
      created_at: new Date('2026-10-18T01:02:03.456Z'),
      updated_at: new Date('2026-10-18T01:02:03.456Z'),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** What the port must return for a stored row: the 12 fields, values as stored. */
export function expectedView(row: WithdrawalRow) {
  return {
    withdrawal_id: row.id,
    user_id: row.user_id,
    status: row.status,
    reject_reason_code: row.reject_reason_code,
    amount_fen: row.amount_fen,
    net_fen: row.net_fen,
    fee_fen: row.fee_fen,
    tax_fen: row.tax_fen,
    fail_code: row.fail_code,
    payout_channel: row.payout_channel,
    created_at: row.created_at,
    paid_at: row.paid_at,
  };
}

/** Everything the port could have touched for one app: withdrawal rows, ledger, events, holds. */
export async function footprint(db: Kysely<DB>, appId: string) {
  const app = db.withSchema('app');
  return {
    withdrawals: await app
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    vouchers: await app
      .selectFrom('ledger_vouchers')
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
    holds: await app
      .selectFrom('withdraw_holds')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}

export function serialise(value: unknown) {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}
