// B2-04zc: GET /v1/wallet/ledger 的查询（BR-FUND-15 用户余额流水；BR-TEXT-19 跳转与 masked）。只读：
// - 分录行：本人 available 子户的分录（infra/wallet-ledger-store.ts），amount_fen 取分录原值的相反数
//   （符号表示对可用余额的影响：入账正、扣减负），balance_after_fen 为该分录记账后的可用余额，
//   accounting_date 为凭证会计日。
// - 汇总条目：每张打款成功（PAID_API / PAID_MANUAL）的提现单 1 条 WITHDRAW_PAID，来自 payout 实现的端口
//   （ledger 声明，app.module 接线）：amount_fen = −实际到账，fee_fen、tax_fen 为明细，
//   balance_after_fen 为 null，按 paid_at 排序、会计日取 paid_at 的 +08:00 日期（payout 用 @couli/domain 算）。
// - 顺序：时刻倒序；同一时刻汇总条目在前、分录在后，各自按 id 倒序。游标只记本页最后一条的来源与
//   id（分录 id 或提现单号），不含任何时刻（masked 的邀请分佣行只能到日，BR-TEXT-19 / J7）；翻页时
//   在本人范围内按 id 回查该行的排序时刻（查不到或不属本人 → cursor 拒绝），两个来源各取
//   limit + 1 条再归并，翻页不重不漏。分录 id 是自增序列，只透露本人分录的先后，不透露时刻。
// - 跳转与 masked（BR-TEXT-19 / J7）：REFERRAL_CREDIT 与受益角色为 direct / indirect 的任何分录都
//   masked、不跳转，也不去问订单号；提现凭证（biz_type withdrawal）跳提现单；带 order_key、受益角色为
//   self / share 的分录经 settlement 的端口换成子订单号后跳订单；其余（无关联单据的 ADMIN_ADJUST、
//   BAD_DEBT_WRITEOFF、REWARD 等）不跳转。
// 所有读取在同一个只读 REPEATABLE READ 事务里；不写库、不加锁、不缓存。
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import {
  readAvailableEntries,
  readAvailableEntryAt,
  type AvailableEntryRow,
} from '../infra/wallet-ledger-store.ts';

export const WALLET_LEDGER_DEFAULT_LIMIT = 20;
export const WALLET_LEDGER_MAX_LIMIT = 50;

export interface WalletLedgerRequest {
  readonly appId: string;
  readonly userId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WalletLedgerPaidInput {
  readonly appId: string;
  readonly userId: string;
  /** idBelow 为 null：只取 paid_at 严格早于 paidAt 的；否则同一时刻再取 id < idBelow 的。 */
  readonly before: { readonly paidAt: string; readonly idBelow: string | null } | null;
  readonly limit: number;
}

/** 一张打款成功的提现单（payout 实现）。paidAt 为 UTC 微秒文本（YYYY-MM-DDTHH:MM:SS.ffffffZ）。 */
export interface WalletLedgerPaidWithdrawal {
  readonly withdrawalId: string;
  readonly feeFen: bigint;
  readonly taxFen: bigint;
  readonly netFen: bigint;
  readonly paidAt: string;
  /** paid_at 的会计日（+08:00 日期），YYYY-MM-DD。 */
  readonly paidDate: string;
}

/** Foreign data comes through owner-module ports, never through ledger table access. */
export interface WalletLedgerDependencies {
  readonly withdrawals: {
    /** 本人打款成功的提现单，paid_at DESC、id DESC，最多 limit 条。 */
    readPaid(
      handle: Kysely<DB>,
      input: WalletLedgerPaidInput,
    ): Promise<readonly WalletLedgerPaidWithdrawal[]>;
    /** 本人一张打款成功的提现单的 paid_at（UTC 微秒文本）；不是本人的或未到账的 → null。 */
    readPaidAt(
      handle: Kysely<DB>,
      input: { readonly appId: string; readonly userId: string; readonly withdrawalId: string },
    ): Promise<string | null>;
  };
  readonly orders: {
    /** order_key → 子订单号（orders.order_id）；查不到的键不在结果里。 */
    readOrderIds(
      handle: Kysely<DB>,
      input: { readonly appId: string; readonly orderKeys: readonly string[] },
    ): Promise<ReadonlyMap<string, string>>;
  };
}

export type WalletLedgerQuery = (request: WalletLedgerRequest) => Promise<Schema<'LedgerListData'>>;

/** cursor / limit 不是本接口给出的值：控制器答 400 / 20001（fields）。 */
export class WalletLedgerQueryError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('ledger: invalid wallet ledger query');
    this.name = 'WalletLedgerQueryError';
    this.fields = fields;
  }
}

// ---- 游标 ---------------------------------------------------------------------------------------

/** 一条流水在全序里的位置：时刻倒序，同一时刻汇总条目（withdrawal）在分录（entry）之前。 */
export interface WalletLedgerPosition {
  readonly at: string;
  readonly source: 'withdrawal' | 'entry';
  readonly id: string;
}

/** 游标里只有来源与 id，不含时刻；时刻由服务端在本人范围内回查。 */
export interface WalletLedgerCursor {
  readonly source: 'withdrawal' | 'entry';
  readonly id: string;
}

const CURSOR_VERSION = 'wl2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRY_ID = /^[1-9][0-9]{0,18}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

export function encodeWalletLedgerCursor(cursor: WalletLedgerCursor): string {
  const source = cursor.source === 'entry' ? 'e' : 'w';
  const json = JSON.stringify([CURSOR_VERSION, source, cursor.id]);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** null for anything that is not a cursor of encodeWalletLedgerCursor; never throws. */
export function decodeWalletLedgerCursor(value: string): WalletLedgerCursor | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [version, source, id] = parsed as unknown[];
    if (version !== CURSOR_VERSION || typeof id !== 'string') return null;
    let cursor: WalletLedgerCursor;
    if (source === 'e') {
      if (!ENTRY_ID.test(id) || BigInt(id) > MAX_BIGINT) return null;
      cursor = { source: 'entry', id };
    } else if (source === 'w') {
      if (!UUID.test(id)) return null;
      cursor = { source: 'withdrawal', id };
    } else {
      return null;
    }
    return encodeWalletLedgerCursor(cursor) === value ? cursor : null;
  } catch {
    return null;
  }
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return WALLET_LEDGER_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > WALLET_LEDGER_MAX_LIMIT) {
    throw new WalletLedgerQueryError(['limit']);
  }
  return limit;
}

/** 分录来源在游标之后的起点：游标是汇总条目时，同一时刻的分录全部在它之后。 */
export function entriesAfter(
  position: WalletLedgerPosition | null,
): { readonly at: string; readonly idBelow: string | null } | null {
  if (position === null) return null;
  return { at: position.at, idBelow: position.source === 'entry' ? position.id : null };
}

/** 汇总来源在游标之后的起点：游标是分录时，同一时刻的汇总条目都已在它之前。 */
export function withdrawalsAfter(
  position: WalletLedgerPosition | null,
): { readonly paidAt: string; readonly idBelow: string | null } | null {
  if (position === null) return null;
  return { paidAt: position.at, idBelow: position.source === 'withdrawal' ? position.id : null };
}

// ---- 归并与投影 ---------------------------------------------------------------------------------

export type WalletLedgerItem =
  | { readonly source: 'entry'; readonly row: AvailableEntryRow }
  | { readonly source: 'withdrawal'; readonly row: WalletLedgerPaidWithdrawal };

/**
 * 两个各自已按（时刻 DESC、id DESC）排好的来源归并成全序：时刻文本定长，按字符串比较；同一时刻
 * 汇总条目在前。
 */
export function mergeNewestFirst(
  entries: readonly AvailableEntryRow[],
  paid: readonly WalletLedgerPaidWithdrawal[],
): WalletLedgerItem[] {
  const merged: WalletLedgerItem[] = [];
  let e = 0;
  let w = 0;
  while (e < entries.length || w < paid.length) {
    const entry = entries[e];
    const withdrawal = paid[w];
    if (withdrawal !== undefined && (entry === undefined || withdrawal.paidAt >= entry.at)) {
      merged.push({ source: 'withdrawal', row: withdrawal });
      w += 1;
    } else if (entry !== undefined) {
      merged.push({ source: 'entry', row: entry });
      e += 1;
    }
  }
  return merged;
}

export function positionOf(item: WalletLedgerItem): WalletLedgerPosition {
  return item.source === 'entry'
    ? { at: item.row.at, source: 'entry', id: item.row.id }
    : { at: item.row.paidAt, source: 'withdrawal', id: item.row.withdrawalId };
}

const OWN_ROLES: readonly string[] = ['self', 'share'];
const REFERRER_ROLES: readonly string[] = ['direct', 'indirect'];
const WITHDRAWAL_BIZ_TYPE = 'withdrawal';

export type EntryLink =
  | { readonly masked: true }
  | { readonly masked: false; readonly kind: 'order'; readonly orderKey: string }
  | { readonly masked: false; readonly kind: 'withdrawal'; readonly withdrawalId: string }
  | { readonly masked: false; readonly kind: 'none' };

/** BR-TEXT-19 跳转与 masked：只看分录类型与凭证（受益角色、业务类型、order_key），不看订单。 */
export function linkOf(
  row: Pick<AvailableEntryRow, 'ledgerType' | 'bizType' | 'bizId' | 'orderKey' | 'role'>,
): EntryLink {
  // J7：邀请分佣与邀请人角色上的任何分录（扣回、补差、调账）都不带订单与下级信息。
  if (row.ledgerType === 'REFERRAL_CREDIT') return { masked: true };
  if (row.role !== null && REFERRER_ROLES.includes(row.role)) return { masked: true };
  if (row.bizType === WITHDRAWAL_BIZ_TYPE && UUID.test(row.bizId)) {
    return { masked: false, kind: 'withdrawal', withdrawalId: row.bizId };
  }
  if (row.orderKey !== null && row.role !== null && OWN_ROLES.includes(row.role)) {
    return { masked: false, kind: 'order', orderKey: row.orderKey };
  }
  return { masked: false, kind: 'none' };
}

function postingEntry(
  row: AvailableEntryRow,
  orderIds: ReadonlyMap<string, string>,
): Schema<'LedgerPostingEntry'> {
  const link = linkOf(row);
  let linkType: 'order' | 'withdrawal' | null = null;
  let linkId: string | null = null;
  if (!link.masked && link.kind === 'withdrawal') {
    linkType = 'withdrawal';
    linkId = link.withdrawalId;
  } else if (!link.masked && link.kind === 'order') {
    const orderId = orderIds.get(link.orderKey);
    if (orderId !== undefined) {
      linkType = 'order';
      linkId = orderId;
    }
  }
  return {
    ledger_type: row.ledgerType,
    sub_type: row.subType,
    // 用户余额是负债：入账贷记为负；流水按对可用余额的影响显示，取相反数。
    amount_fen: fenToJsonNumber(subFen(0n, row.amountFen)),
    accounting_date: row.accountingDate,
    link_type: linkType,
    link_id: linkId,
    masked: link.masked,
    balance_after_fen: fenToJsonNumber(row.balanceAfterFen),
  };
}

function paidEntry(row: WalletLedgerPaidWithdrawal): Schema<'LedgerWithdrawPaidEntry'> {
  return {
    ledger_type: 'WITHDRAW_PAID',
    sub_type: null,
    amount_fen: fenToJsonNumber(subFen(0n, row.netFen)),
    accounting_date: row.paidDate,
    link_type: 'withdrawal',
    link_id: row.withdrawalId,
    masked: false,
    balance_after_fen: null,
    fee_fen: fenToJsonNumber(row.feeFen),
    tax_fen: fenToJsonNumber(row.taxFen),
  };
}

function entryJson(
  item: WalletLedgerItem,
  orderIds: ReadonlyMap<string, string>,
): Schema<'LedgerEntry'> {
  if (item.source === 'entry') return postingEntry(item.row, orderIds);
  return paidEntry(item.row);
}

/** 一页里需要换子订单号的 order_key（masked 的分录不在其中）。 */
export function orderKeysOf(items: readonly WalletLedgerItem[]): string[] {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.source !== 'entry') continue;
    const link = linkOf(item.row);
    if (!link.masked && link.kind === 'order') keys.add(link.orderKey);
  }
  return [...keys];
}

/** 纯函数：一页条目投影成契约 LedgerListData。 */
export function projectWalletLedger(
  page: readonly WalletLedgerItem[],
  orderIds: ReadonlyMap<string, string>,
  next: WalletLedgerCursor | null,
): Schema<'LedgerListData'> {
  return {
    items: page.map((item) => entryJson(item, orderIds)),
    next_cursor: next === null ? null : encodeWalletLedgerCursor(next),
  };
}

/** Runs on the caller's transaction, or on its own read-only REPEATABLE READ one. */
async function readOnly<T>(db: Kysely<DB>, run: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  if (db.isTransaction) return run(db);
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute((trx: Transaction<DB>) => run(trx));
}

/**
 * 游标所指那一行的排序时刻，只在本人范围内回查（本人 available 子户上会出现在流水里的分录、本人
 * 打款成功的提现单）；查不到或不属本人 → cursor 拒绝。
 */
async function resolveCursor(
  trx: Kysely<DB>,
  subject: { readonly appId: string; readonly userId: string },
  cursor: WalletLedgerCursor | null,
  dependencies: WalletLedgerDependencies,
): Promise<WalletLedgerPosition | null> {
  if (cursor === null) return null;
  const at =
    cursor.source === 'entry'
      ? await readAvailableEntryAt(trx, { ...subject, entryId: cursor.id })
      : await dependencies.withdrawals.readPaidAt(trx, { ...subject, withdrawalId: cursor.id });
  if (at === null) throw new WalletLedgerQueryError(['cursor']);
  return { at, source: cursor.source, id: cursor.id };
}

export async function getWalletLedger(
  db: Kysely<DB>,
  request: WalletLedgerRequest,
  dependencies: WalletLedgerDependencies,
): Promise<Schema<'LedgerListData'>> {
  const limit = pageSize(request.limit);
  let cursor: WalletLedgerCursor | null = null;
  if (request.cursor !== undefined) {
    cursor = decodeWalletLedgerCursor(request.cursor);
    if (cursor === null) throw new WalletLedgerQueryError(['cursor']);
  }
  const subject = { appId: request.appId, userId: request.userId };
  return readOnly(db, async (trx) => {
    const position = await resolveCursor(trx, subject, cursor, dependencies);
    // 每个来源多取 1 条：归并后超过 limit 即还有下一页；不超过时两个来源都已读完。
    const entries = await readAvailableEntries(trx, {
      ...subject,
      before: entriesAfter(position),
      limit: limit + 1,
    });
    const paid = await dependencies.withdrawals.readPaid(trx, {
      ...subject,
      before: withdrawalsAfter(position),
      limit: limit + 1,
    });
    const merged = mergeNewestFirst(entries, paid);
    const page = merged.slice(0, limit);
    const last = page.at(-1);
    const next = merged.length > limit && last !== undefined ? positionOf(last) : null;
    const orderKeys = orderKeysOf(page);
    const orderIds =
      orderKeys.length === 0
        ? new Map<string, string>()
        : await dependencies.orders.readOrderIds(trx, { appId: subject.appId, orderKeys });
    return projectWalletLedger(page, orderIds, next);
  });
}
