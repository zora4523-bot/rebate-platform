// B2-05c: the counts of BR-WDR-04 read on the caller's handle (the claim transaction sees its own
// uncommitted rows): rows of app.withdrawals whose created_at falls in the +08:00 natural day /
// month of `now` (half-open ranges of @couli/domain, never a SQL clock) and whose status is not
// REJECTED / FAILED (驳回和打款失败不占次数). The member's own counts by user_id; the payee counts
// by the snapshot HMAC of the withdrawal rows (payee_hmac, whatever account the member holds
// now), across members of the same app: payee_daily_count counts rows, payee_daily_other_users
// counts distinct OTHER members. No payee HMAC (nothing bound) → both 0. Read only, no logging.
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange, chinaMonth, chinaMonthRange } from '@couli/domain';
import { sql, type Kysely } from 'kysely';
import type { WithdrawUsageReader } from '../application/withdraw-rules.ts';
import type { WithdrawUsage } from '../domain/withdraw-rules.ts';

const EXCLUDED = ['REJECTED', 'FAILED'] as const;

function count(value: string | number | bigint): number {
  return Number(value);
}

function fen(value: string | number | bigint | null): bigint {
  return value === null ? 0n : BigInt(value);
}

export function createWithdrawUsageReader(): WithdrawUsageReader {
  return {
    async read(handle: Kysely<DB>, input): Promise<WithdrawUsage> {
      const day = chinaDayRange(accountingDate(input.now));
      const month = chinaMonthRange(chinaMonth(input.now));
      const dayStart = sql<Date>`${day.start}::timestamptz`;
      const dayEnd = sql<Date>`${day.end}::timestamptz`;
      const monthStart = sql<Date>`${month.start}::timestamptz`;
      const monthEnd = sql<Date>`${month.end}::timestamptz`;
      const own = await handle
        .withSchema('app')
        .selectFrom('withdrawals')
        .select((eb) => [
          eb.fn
            .count<string>('id')
            .filterWhere('created_at', '>=', dayStart)
            .filterWhere('created_at', '<', dayEnd)
            .as('daily_count'),
          eb.fn.count<string>('id').as('monthly_count'),
          eb.fn.coalesce(eb.fn.sum<string>('amount_fen'), sql<string>`0`).as('monthly_amount_fen'),
        ])
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .where('status', 'not in', [...EXCLUDED])
        .where('created_at', '>=', monthStart)
        .where('created_at', '<', monthEnd)
        .executeTakeFirstOrThrow();
      let payeeCount = 0;
      let otherUsers = 0;
      if (input.payeeHmac !== null) {
        const payee = await handle
          .withSchema('app')
          .selectFrom('withdrawals')
          .select((eb) => [
            eb.fn.count<string>('id').as('payee_daily_count'),
            eb.fn
              .count<string>('user_id')
              .distinct()
              .filterWhere('user_id', '<>', input.userId)
              .as('payee_daily_other_users'),
          ])
          .where('app_id', '=', input.appId)
          .where('payee_hmac', '=', input.payeeHmac)
          .where('status', 'not in', [...EXCLUDED])
          .where('created_at', '>=', dayStart)
          .where('created_at', '<', dayEnd)
          .executeTakeFirstOrThrow();
        payeeCount = count(payee.payee_daily_count);
        otherUsers = count(payee.payee_daily_other_users);
      }
      return {
        daily_count: count(own.daily_count),
        monthly_count: count(own.monthly_count),
        payee_daily_count: payeeCount,
        payee_daily_other_users: otherUsers,
        monthly_amount_fen: fen(own.monthly_amount_fen),
      };
    },
  };
}
