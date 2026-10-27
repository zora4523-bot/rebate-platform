// Identity's read port for the withdrawal risk-flag snapshot (task B2-11a; 08 BR-WDR-29 ⑩, BR-WDR-02
// 细则「若某 alipay_hmac 近 90 天内曾被其他会员绑定过，允许绑定，但之后的提现单打
// payee_prev_other_user」; the bank card the same, FUND-03). On the caller's handle, plain SELECTs,
// no cipher read, no writes, no logging.
// - currentBinding: the binding time (created_at) of the member's current payout account holding
//   the HMAC, or null when the current account holds another one (or none).
// - heldByOtherBetween: another member bound the HMAC no later than `to` and still held it at or
//   after `from`. A binding ended when its member changed away from the HMAC
//   (payout_account_changes.old_hmac, the first change at or after the binding); a row without
//   such a change ends at its last update unless it is still current.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface PayeeBindingHistoryReader {
  currentBinding(
    handle: Kysely<DB>,
    input: { appId: string; userId: string; payeeHmac: string },
  ): Promise<Date | null>;
  heldByOtherBetween(
    handle: Kysely<DB>,
    input: { appId: string; userId: string; payeeHmac: string; from: Date; to: Date },
  ): Promise<boolean>;
}

export function createPayeeBindingHistoryReader(): PayeeBindingHistoryReader {
  return {
    async currentBinding(handle, input) {
      const row = await handle
        .withSchema('app')
        .selectFrom('payout_accounts')
        .select('created_at')
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .where('is_current', '=', true)
        .where((eb) =>
          eb.or([
            eb('alipay_hmac', '=', input.payeeHmac),
            eb('bank_card_hmac', '=', input.payeeHmac),
          ]),
        )
        .executeTakeFirst();
      return row === undefined ? null : row.created_at;
    },
    async heldByOtherBetween(handle, input) {
      const { rows } = await sql<{ one: number }>`
        SELECT 1 AS one
        FROM app.payout_accounts p
        LEFT JOIN LATERAL (
          SELECT min(c.changed_at) AS ended_at
          FROM app.payout_account_changes c
          WHERE c.app_id = p.app_id AND c.user_id = p.user_id AND c.old_hmac = ${input.payeeHmac}
            AND c.changed_at >= p.created_at
        ) ch ON true
        WHERE p.app_id = ${input.appId}
          AND p.user_id <> ${input.userId}
          AND (p.alipay_hmac = ${input.payeeHmac} OR p.bank_card_hmac = ${input.payeeHmac})
          AND p.created_at <= ${input.to}
          AND (
            p.is_current
            OR ch.ended_at >= ${input.from}
            OR (ch.ended_at IS NULL AND p.updated_at >= ${input.from})
          )
        LIMIT 1`.execute(handle);
      return rows.length > 0;
    },
  };
}
