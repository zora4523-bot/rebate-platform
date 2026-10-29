// B2-13a（BR-FUND-25 细则「已结算怎样聚合」）：本人 USER_BALANCE 账户 available 子户上
// REBATE_CREDIT / SHARE_CREDIT / REFERRAL_CREDIT 分录按凭证会计日、按类型的原值合计（amount_fen 的
// 代数和；入账为负、红冲为正，取反由调用方做）。平台科目与别人账户上的分录不取；SETTLE_ADJUST、
// CLAWBACK、ADMIN_ADJUST 等其余类型不取。platform 只筛 REBATE_CREDIT / SHARE_CREDIT（按凭证
// order_key 的 `{platform}:` 前缀，BR-FUND-05），REFERRAL_CREDIT 始终全部平台。
// 只读调用方句柄上的 SELECT：不加锁、不写库、不读 SQL 时钟。
import type { DB } from '@couli/db';
import { parseFen } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import { USER_SUBJECT } from './store.ts';

export const EARNINGS_CREDIT_TYPES = ['REBATE_CREDIT', 'SHARE_CREDIT', 'REFERRAL_CREDIT'] as const;
export type EarningsCreditType = (typeof EARNINGS_CREDIT_TYPES)[number];

export interface CreditedDayInput {
  readonly appId: string;
  readonly userId: string;
  /** 会计日窗口 [dateFrom, dateTo)，YYYY-MM-DD。 */
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly platform: string | null;
}

export interface CreditedDayRow {
  readonly ledgerType: EarningsCreditType;
  /** accounting_date，YYYY-MM-DD。 */
  readonly day: string;
  /** 该日该类型分录 amount_fen 的原值合计。 */
  readonly amountFen: bigint;
}

function creditTypeOf(value: string): EarningsCreditType {
  const found = EARNINGS_CREDIT_TYPES.find((type) => type === value);
  if (found === undefined) throw new Error('ledger: unexpected ledger_type in earnings read');
  return found;
}

export async function readCreditedByDay(
  handle: Kysely<DB>,
  input: CreditedDayInput,
): Promise<CreditedDayRow[]> {
  const prefix = input.platform === null ? null : `${input.platform}:`;
  const rows = await handle
    .withSchema('app')
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_accounts as a', (join) =>
      join.onRef('a.app_id', '=', 'e.app_id').onRef('a.id', '=', 'e.account_id'),
    )
    .innerJoin('ledger_vouchers as v', (join) =>
      join.onRef('v.app_id', '=', 'e.app_id').onRef('v.id', '=', 'e.voucher_id'),
    )
    .select([
      'e.ledger_type',
      sql<string>`to_char(v.accounting_date, 'YYYY-MM-DD')`.as('day'),
      sql<string>`sum(e.amount_fen)::text`.as('amount_fen'),
    ])
    .where('a.app_id', '=', input.appId)
    .where('a.owner_type', '=', 'user')
    .where('a.owner_id', '=', input.userId)
    .where('a.subject', '=', USER_SUBJECT)
    .where('e.app_id', '=', input.appId)
    .where('e.sub_account', '=', 'available')
    .where('e.ledger_type', 'in', [...EARNINGS_CREDIT_TYPES])
    .where('v.app_id', '=', input.appId)
    .where(sql<boolean>`v.accounting_date >= cast(${input.dateFrom} as date)`)
    .where(sql<boolean>`v.accounting_date < cast(${input.dateTo} as date)`)
    .$if(prefix !== null, (qb) =>
      qb.where((eb) =>
        eb.or([
          eb('e.ledger_type', '=', 'REFERRAL_CREDIT'),
          sql<boolean>`starts_with(v.order_key, ${prefix ?? ''})`,
        ]),
      ),
    )
    .groupBy(['e.ledger_type', 'v.accounting_date'])
    .orderBy('v.accounting_date')
    .orderBy('e.ledger_type')
    .execute();
  return rows.map((row) => ({
    ledgerType: creditTypeOf(row.ledger_type),
    day: row.day,
    amountFen: parseFen(row.amount_fen),
  }));
}
