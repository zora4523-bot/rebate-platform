// B2-04zc（BR-FUND-15、BR-TEXT-19）：余额流水的提现到账汇总条目来源——本人打款成功（PAID_API /
// PAID_MANUAL）的提现单，每张 1 行：申请金额、手续费、代扣税、实际到账（net_fen）与到账时刻
// paid_at。由 ledger 的余额流水经 app.module 接线调用，ledger 不读本模块的表。
// 顺序：paid_at DESC、id DESC；paid_at 以 UTC 微秒文本返回（YYYY-MM-DDTHH:MM:SS.ffffffZ），供调用方
// 按同一格式比较与编游标。只读调用方句柄上的 SELECT：不加锁、不写库、不读时钟、不打日志。
//
// Also compiled by the `test` project: erasable syntax only.
import type { DB } from '@couli/db';
import { accountingDate } from '@couli/domain';
import { parseFen } from '@couli/money';
import { sql, type Kysely, type RawBuilder } from 'kysely';

const PAID = ['PAID_API', 'PAID_MANUAL'] as const;

export interface PaidWithdrawalSummariesInput {
  readonly appId: string;
  readonly userId: string;
  /**
   * 只取排在这个位置之后（更早）的提现单；null = 从最新开始。idBelow 为 null 时只取 paid_at 严格
   * 早于 paidAt 的；否则取 paid_at < paidAt，或同一时刻且 id < idBelow。
   */
  readonly before: { readonly paidAt: string; readonly idBelow: string | null } | null;
  readonly limit: number;
}

export interface PaidWithdrawalSummary {
  readonly withdrawalId: string;
  readonly amountFen: bigint;
  readonly feeFen: bigint;
  readonly taxFen: bigint;
  /** 实际到账 = amount − fee − tax（表上的约束保证）。 */
  readonly netFen: bigint;
  /** paid_at，UTC 微秒文本。 */
  readonly paidAt: string;
  /** paid_at 的会计日（+08:00 日期，@couli/domain 的 accountingDate），YYYY-MM-DD。 */
  readonly paidDate: string;
}

/** paid_at 的 UTC 微秒文本。 */
const PAID_AT_UTC = sql<string>`to_char(
  paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
)`;

/** 游标之后（更早）的提现单条件；before 为 null 时不限。 */
function afterPosition(before: PaidWithdrawalSummariesInput['before']): RawBuilder<boolean> {
  if (before === null) return sql<boolean>`true`;
  const at = sql`cast(${before.paidAt} as timestamptz)`;
  if (before.idBelow === null) return sql<boolean>`paid_at < ${at}`;
  const id = sql`cast(${before.idBelow} as uuid)`;
  return sql<boolean>`(paid_at < ${at} OR (paid_at = ${at} AND id < ${id}))`;
}

export async function readPaidWithdrawalSummaries(
  handle: Kysely<DB>,
  input: PaidWithdrawalSummariesInput,
): Promise<PaidWithdrawalSummary[]> {
  const rows = await handle
    .withSchema('app')
    .selectFrom('withdrawals')
    .select([
      sql<string>`id::text`.as('id'),
      sql<string>`amount_fen::text`.as('amount_fen'),
      sql<string>`fee_fen::text`.as('fee_fen'),
      sql<string>`tax_fen::text`.as('tax_fen'),
      sql<string>`net_fen::text`.as('net_fen'),
      PAID_AT_UTC.as('paid_at_text'),
      'paid_at',
    ])
    .where('app_id', '=', input.appId)
    .where('user_id', '=', input.userId)
    .where('status', 'in', [...PAID])
    .where('paid_at', 'is not', null)
    .where(afterPosition(input.before))
    .orderBy('paid_at', 'desc')
    .orderBy('id', 'desc')
    .limit(input.limit)
    .execute();
  return rows.map((row) => {
    // PAID_API / PAID_MANUAL 必有 paid_at（表上的约束）；查询也已排除 null。
    if (row.paid_at === null) throw new Error('payout: a paid withdrawal has no paid_at');
    return {
      withdrawalId: row.id,
      amountFen: parseFen(row.amount_fen),
      feeFen: parseFen(row.fee_fen),
      taxFen: parseFen(row.tax_fen),
      netFen: parseFen(row.net_fen),
      paidAt: row.paid_at_text,
      paidDate: accountingDate(row.paid_at),
    };
  });
}
