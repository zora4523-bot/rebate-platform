// 实名更正后的收款账号失效 (规划/08 BR-WDR-02 细则「实名更正后的失效与重绑」; 04 §3.2
// payout_account_changes.limit_exempt_reason; task B2-05j, used by admin B1-27g).
//
// createPayoutAccountInvalidation().invalidate — inside the caller's transaction, which already
// holds the users row lock of the subject (B1-27g's realname correction): every current
// payout_accounts row of the user is set is_current=false (row_version CAS, updated_at = now) and
// one payout_account_changes row is appended per retired row (old_* from that row,
// new_payout_method = the old method, new_hmac = '' — no new account, operator as given,
// changed_at = now, limit_exempt_reason = 'realname_correction'). No current row → nothing
// written, { retired: 0 }. No audit row and no event here (B1-27g writes its own).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';

/** 04 §3.2: the one limit_exempt_reason value (BR-WDR-02 细则「实名更正后的失效与重绑」). */
export const REALNAME_CORRECTION_EXEMPT = 'realname_correction';
const EXEMPT_REASON = REALNAME_CORRECTION_EXEMPT;

interface CurrentRow {
  readonly payout_method: string;
  readonly alipay_hmac: string | null;
  readonly bank_card_hmac: string | null;
}

/** The HMAC that identifies the account of its payout_method (BR-WDR-02 细则; same as payout-account.ts). */
function accountHmac(row: CurrentRow): string {
  const hmac = row.payout_method === 'alipay' ? row.alipay_hmac : row.bank_card_hmac;
  if (hmac === null) throw new Error('identity: payout account row without its HMAC');
  return hmac;
}

export interface PayoutAccountInvalidationCommand {
  readonly appId: string;
  readonly userId: string;
  /** Recorded as is on the change rows, e.g. 'admin:<id>'. */
  readonly operator: string;
  readonly now: Date;
}

export interface PayoutAccountInvalidationResult {
  /** Current rows set is_current=false (one exempt change row each). */
  readonly retired: number;
}

export interface PayoutAccountInvalidation {
  invalidate(
    trx: Transaction<DB>,
    command: PayoutAccountInvalidationCommand,
  ): Promise<PayoutAccountInvalidationResult>;
}

export function createPayoutAccountInvalidation(): PayoutAccountInvalidation {
  return {
    async invalidate(trx, command) {
      const { appId, userId, operator, now } = command;
      // The caller holds the users row lock: nobody else writes this user's accounts meanwhile.
      const current = await trx
        .withSchema('app')
        .selectFrom('payout_accounts')
        .select(['id', 'payout_method', 'alipay_hmac', 'bank_card_hmac', 'row_version'])
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .where('is_current', '=', true)
        .orderBy('id')
        .execute();
      let retired = 0;
      for (const row of current) {
        const result = await trx
          .withSchema('app')
          .updateTable('payout_accounts')
          .set({ is_current: false, row_version: row.row_version + 1, updated_at: now })
          .where('app_id', '=', appId)
          .where('id', '=', row.id)
          .where('is_current', '=', true)
          .where('row_version', '=', row.row_version)
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) {
          throw new Error('identity: current payout account changed under the user lock');
        }
        const hmac = accountHmac(row);
        // limit_exempt_reason is not in the generated types until the schema snapshot: plain SQL.
        await sql`INSERT INTO app.payout_account_changes
          (app_id, user_id, old_payout_method, new_payout_method, old_hmac, new_hmac, operator,
           changed_at, created_at, limit_exempt_reason)
          VALUES (${appId}, ${userId}, ${row.payout_method}, ${row.payout_method}, ${hmac}, '',
            ${operator}, ${now}, ${now}, ${EXEMPT_REASON})`.execute(trx);
        retired += 1;
      }
      return { retired };
    },
  };
}
