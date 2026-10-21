import { formatYuan, parseFen } from '@couli/money';
import type { ApiData } from '../../../../shared/api/index.ts';
import { ledgerText, ledgerTexts } from '../../../../texts/ledger.ts';

export type LedgerListData = ApiData<'GET', '/v1/wallet/ledger'>;
export type LedgerEntry = LedgerListData['items'][number];

/** 跳转目标：经桥 nav.open 打开的原生路由与参数（BR-TEXT-19 跳转列）。 */
export type LedgerLink =
  | { route: 'OrderDetail'; params: { order_id: string } }
  | { route: 'WithdrawRecords'; params: { withdrawal_id: string } };

/** 一行流水的展示数据；金额与日期已格式化，文字已按字典取好。 */
export interface LedgerRow {
  name: string;
  /** 第二行的说明（邀请好友订单、活动奖励、调账原因、核销说明）；没有为 null。 */
  hint: string | null;
  date: string;
  amount: string;
  /** 返利类入账用返利强调色，其余用正文色（规格 §2「金额颜色」）；正负只看符号不看颜色。 */
  accent: boolean;
  /** 「余额 {amount}」；WITHDRAW_PAID 汇总条目为 null，不显示。 */
  balance: string | null;
  link: LedgerLink | null;
  /** WITHDRAW_PAID 汇总条目的明细（代扣个税、手续费）；其他行为 null。 */
  details: { label: string; amount: string }[] | null;
}

/** ADMIN_ADJUST 的注销放弃余额对用户不可见（BR-TEXT-19 原因码表）。 */
export function isVisible(entry: LedgerEntry): boolean {
  return !(entry.ledger_type === 'ADMIN_ADJUST' && entry.sub_type === 'ACCOUNT_CLOSED');
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 当前上海日期所在的年（YYYY）。 */
export function shanghaiYear(nowMs: number): string {
  return new Date(nowMs + BEIJING_OFFSET_MS).toISOString().slice(0, 4);
}

/** BR-TEXT-11 纯日期字段：与今天同年显示 MM-DD，否则 YYYY-MM-DD；不用「今天」等相对词。 */
export function formatAccountingDate(date: string, currentYear: string): string {
  const match = DATE.exec(date);
  if (match === null) return date;
  return match[1] === currentYear ? `${match[2]}-${match[3]}` : date;
}

/** 会计日所在月的分组键 YYYY-MM；格式不对时整串作键。 */
export function monthKey(date: string): string {
  const match = DATE.exec(date);
  return match === null ? date : `${match[1]}-${match[2]}`;
}

/** 分组标题「YYYY 年 M 月」。 */
export function monthTitle(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (match === null) return key;
  return ledgerTexts.month(match[1]!, String(Number(match[2])));
}

function named(...keys: string[]): string {
  for (const key of keys) {
    const text = ledgerText(key);
    if (text !== '') return text;
  }
  return ledgerTexts.unknownType;
}

function nameAndHint(entry: LedgerEntry): { name: string; hint: string | null } {
  const type = entry.ledger_type;
  const base = `ledger_type.${type}`;
  const sub = entry.sub_type;
  let name: string;
  let hint: string | null = null;
  if (type === 'REFERRAL_CREDIT' && sub === 'INDIRECT') {
    name = named(`${base}.name_indirect`);
  } else if (type === 'CLAWBACK' && sub === 'PART_REFUND') {
    name = named(`${base}.name_part_refund`);
  } else if (type === 'ADMIN_ADJUST') {
    // 按原因码取名称与说明；未知原因码按 OTHER（人工调账）显示。
    const known = sub !== null && ledgerText(`${base}.name_${sub}`) !== '';
    const code = known ? sub : 'OTHER';
    name = named(`${base}.name_${code}`);
    hint = ledgerText(`${base}.hint_${code}`) || null;
  } else if (type === 'REWARD') {
    name = sub === null ? named(`${base}.name`) : named(`${base}.name_${sub}`, `${base}.name`);
    hint = (sub === null ? '' : ledgerText(`${base}.hint_${sub}`)) || null;
  } else {
    name = named(`${base}.name`);
    if (type === 'BAD_DEBT_WRITEOFF') hint = ledgerText(`${base}.hint`) || null;
  }
  // 邀请分佣类流水只显示「邀请好友订单」，不展示下级与订单信息（BR-TEXT-19、J7）。
  if (entry.masked) hint = ledgerTexts.referralHint;
  return { name, hint };
}

/** 返利类入账（含正的结算补差）用返利强调色（规格 §2、画板 LedgerStates 设计说明）。 */
function isRebateAccent(entry: LedgerEntry, fen: bigint): boolean {
  switch (entry.ledger_type) {
    case 'REBATE_CREDIT':
    case 'SHARE_CREDIT':
    case 'REFERRAL_CREDIT':
    case 'SETTLE_ADJUST':
      return fen > 0n;
    default:
      return false;
  }
}

/** masked 与 REWARD 行不可点；link_type / link_id 都有才可点，目标只看 link_type。 */
function linkOf(entry: LedgerEntry): LedgerLink | null {
  if (entry.masked || entry.ledger_type === 'REWARD') return null;
  if (entry.link_id === null || entry.link_id === '') return null;
  if (entry.link_type === 'order') {
    return { route: 'OrderDetail', params: { order_id: entry.link_id } };
  }
  if (entry.link_type === 'withdrawal') {
    return { route: 'WithdrawRecords', params: { withdrawal_id: entry.link_id } };
  }
  return null;
}

/** 金额一律经 @couli/money 的整数分格式化（BR-TEXT-10，流水正数加「+」）。 */
export function toRow(entry: LedgerEntry, currentYear: string): LedgerRow {
  const { name, hint } = nameAndHint(entry);
  const fen = parseFen(entry.amount_fen);
  const date = formatAccountingDate(entry.accounting_date, currentYear);
  const link = linkOf(entry);
  if (entry.ledger_type === 'WITHDRAW_PAID') {
    // 汇总条目不影响可用余额（BR-TEXT-19 符号 0）：金额不带正负号，不显示变动后余额。
    return {
      name,
      hint,
      date,
      amount: formatYuan(fen < 0n ? -fen : fen),
      accent: false,
      balance: null,
      link,
      details: [
        {
          label: named('ledger_type.TAX_WITHHOLD.name'),
          amount: formatYuan(parseFen(entry.tax_fen)),
        },
        { label: ledgerTexts.feeLabel, amount: formatYuan(parseFen(entry.fee_fen)) },
      ],
    };
  }
  return {
    name,
    hint,
    date,
    amount: formatYuan(fen, { signed: true }),
    accent: isRebateAccent(entry, fen),
    balance: ledgerText('ledger.balance_after', {
      amount: formatYuan(parseFen(entry.balance_after_fen)),
    }),
    link,
    details: null,
  };
}

export interface LedgerGroup {
  key: string;
  month: string;
  title: string;
  rows: { key: string; row: LedgerRow }[];
}

/** 按会计月分组，保持接口顺序（新到旧）；跨页的同月流水并入同一组。 */
export function groupByMonth(entries: readonly LedgerEntry[], nowMs: number): LedgerGroup[] {
  const year = shanghaiYear(nowMs);
  const groups: LedgerGroup[] = [];
  entries.forEach((entry, index) => {
    if (!isVisible(entry)) return;
    const key = monthKey(entry.accounting_date);
    let group = groups.at(-1);
    if (group === undefined || group.month !== key) {
      group = { key: `${groups.length}-${key}`, month: key, title: monthTitle(key), rows: [] };
      groups.push(group);
    }
    group.rows.push({ key: String(index), row: toRow(entry, year) });
  });
  return groups;
}
