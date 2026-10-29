// B2-04zc（BR-FUND-15、BR-TEXT-19）：余额流水的分录行——本人 USER_BALANCE 账户 available 子户上的
// 分录，带所在凭证的会计日、业务类型与单号、order_key 与受益角色（跳转与 masked 由调用方判定）。
// frozen 子户、平台科目、别人与别的 app 的分录都不取；WITHDRAW_FEE、TAX_WITHHOLD 不单独成行，
// WITHDRAW_PAID 由提现单的汇总条目代替（都只记在 frozen 子户上，这里按类型再排除一次）。
// 顺序：booked_at DESC、id DESC；时刻以 UTC 微秒文本返回，翻页比较不丢精度（时刻只在服务端用，不进游标）。
// 只读调用方句柄上的 SELECT：不加锁、不写库、不读 SQL 时钟。
import type { DB } from '@couli/db';
import { parseFen } from '@couli/money';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { USER_SUBJECT } from './store.ts';

/** 余额流水里以分录行出现的 ledger_type（契约 LedgerPostingEntry 去掉只作汇总明细的两种）。 */
export const WALLET_LEDGER_ENTRY_TYPES = [
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'CLAWBACK',
  'SETTLE_ADJUST',
  'WITHDRAW_FREEZE',
  'WITHDRAW_RETURN',
  'REWARD',
  'ADMIN_ADJUST',
  'BAD_DEBT_WRITEOFF',
] as const;
export type WalletLedgerEntryType = (typeof WALLET_LEDGER_ENTRY_TYPES)[number];

export interface AvailableEntriesInput {
  readonly appId: string;
  readonly userId: string;
  /**
   * 只取排在这个位置之后（更早）的分录；null = 从最新开始。idBelow 为 null 时取 booked_at ≤ at
   * 的全部（同一时刻的分录排在该时刻的汇总条目之后）；否则取 booked_at < at，或同一时刻且
   * id < idBelow。
   */
  readonly before: { readonly at: string; readonly idBelow: string | null } | null;
  readonly limit: number;
}

export interface AvailableEntryRow {
  /** ledger_entries.id（bigint 的十进制文本）。 */
  readonly id: string;
  /** booked_at，UTC 微秒文本。 */
  readonly at: string;
  readonly ledgerType: WalletLedgerEntryType;
  readonly subType: string | null;
  /** 分录原值：用户余额是负债，入账（贷记）为负、扣减为正（BR-FUND-16）。 */
  readonly amountFen: bigint;
  /** 该分录记账后的 available 子户余额。 */
  readonly balanceAfterFen: bigint;
  /** 凭证会计日，YYYY-MM-DD。 */
  readonly accountingDate: string;
  readonly bizType: string;
  readonly bizId: string;
  readonly orderKey: string | null;
  readonly role: string | null;
}

/** booked_at 的 UTC 微秒文本。 */
const BOOKED_AT_UTC = sql<string>`to_char(
  e.booked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
)`;

/** 游标之后（更早）的分录条件；before 为 null 时不限。 */
function afterPosition(before: AvailableEntriesInput['before']): RawBuilder<boolean> {
  if (before === null) return sql<boolean>`true`;
  const at = sql`cast(${before.at} as timestamptz)`;
  if (before.idBelow === null) return sql<boolean>`e.booked_at <= ${at}`;
  const id = sql`cast(${before.idBelow} as bigint)`;
  return sql<boolean>`(e.booked_at < ${at} OR (e.booked_at = ${at} AND e.id < ${id}))`;
}

function entryTypeOf(value: string): WalletLedgerEntryType {
  const found = WALLET_LEDGER_ENTRY_TYPES.find((type) => type === value);
  if (found === undefined) throw new Error('ledger: unexpected ledger_type in wallet ledger read');
  return found;
}

export async function readAvailableEntries(
  handle: Kysely<DB>,
  input: AvailableEntriesInput,
): Promise<AvailableEntryRow[]> {
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
      sql<string>`e.id::text`.as('id'),
      BOOKED_AT_UTC.as('at'),
      'e.ledger_type',
      'e.sub_type',
      sql<string>`e.amount_fen::text`.as('amount_fen'),
      sql<string | null>`e.balance_after_fen::text`.as('balance_after_fen'),
      sql<string>`to_char(v.accounting_date, 'YYYY-MM-DD')`.as('accounting_date'),
      'v.biz_type',
      'v.biz_id',
      'v.order_key',
      'v.role',
    ])
    .where('a.app_id', '=', input.appId)
    .where('a.owner_type', '=', 'user')
    .where('a.owner_id', '=', input.userId)
    .where('a.subject', '=', USER_SUBJECT)
    .where('e.app_id', '=', input.appId)
    .where('e.sub_account', '=', 'available')
    .where('e.ledger_type', 'in', [...WALLET_LEDGER_ENTRY_TYPES])
    .where('v.app_id', '=', input.appId)
    .where(afterPosition(input.before))
    .orderBy('e.booked_at', 'desc')
    .orderBy('e.id', 'desc')
    .limit(input.limit)
    .execute();
  return rows.map((row) => {
    if (row.balance_after_fen === null) {
      // ledger.post 给用户账户的每条分录都写变动后余额；缺了就是账本坏了，不臆造。
      throw new Error('ledger: a user entry has no balance_after_fen');
    }
    return {
      id: row.id,
      at: row.at,
      ledgerType: entryTypeOf(row.ledger_type),
      subType: row.sub_type,
      amountFen: parseFen(row.amount_fen),
      balanceAfterFen: parseFen(row.balance_after_fen),
      accountingDate: row.accounting_date,
      bizType: row.biz_type,
      bizId: row.biz_id,
      orderKey: row.order_key,
      role: row.role,
    };
  });
}

export interface AvailableEntryAtInput {
  readonly appId: string;
  readonly userId: string;
  /** ledger_entries.id（bigint 的十进制文本，调用方已校验格式）。 */
  readonly entryId: string;
}

/**
 * 游标回查：本人 USER_BALANCE 账户 available 子户上、会出现在余额流水里的这条分录的 booked_at（UTC
 * 微秒文本，与 readAvailableEntries 的 at 同一格式）；别人的、别的 app 的、frozen 子户或平台科目的、
 * 不出现在流水里的类型 → null。
 */
export async function readAvailableEntryAt(
  handle: Kysely<DB>,
  input: AvailableEntryAtInput,
): Promise<string | null> {
  const row = await handle
    .withSchema('app')
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_accounts as a', (join) =>
      join.onRef('a.app_id', '=', 'e.app_id').onRef('a.id', '=', 'e.account_id'),
    )
    .select(BOOKED_AT_UTC.as('at'))
    .where('a.app_id', '=', input.appId)
    .where('a.owner_type', '=', 'user')
    .where('a.owner_id', '=', input.userId)
    .where('a.subject', '=', USER_SUBJECT)
    .where('e.app_id', '=', input.appId)
    .where('e.sub_account', '=', 'available')
    .where('e.ledger_type', 'in', [...WALLET_LEDGER_ENTRY_TYPES])
    .where(sql<boolean>`e.id = cast(${input.entryId} as bigint)`)
    .executeTakeFirst();
  return row === undefined ? null : row.at;
}
