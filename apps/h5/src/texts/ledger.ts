// 余额流水页（F1-04a）的文案。流水名称与说明先取契约字典 contracts/texts.default.json（经 t()），
// 字典还没有的键用这里的包内默认：名称与 ADMIN_ADJUST 原因码文案逐字取自 08 BR-TEXT-19 表；
// BAD_DEBT_WRITEOFF 的说明与空态两句取自规格 design/specs/app-ledger.md §7 与画板原文（08 尚无字典键，
// 由编排者登记补键）；字典补上后以字典为准。
import { t } from '../shared/texts.ts';

/** 字典缺键时的包内默认，键名与字典同形（ledger_type.<CODE>.name / .hint 等）。 */
const ledgerDefaults: Readonly<Record<string, string>> = {
  'ledger_type.REBATE_CREDIT.name': '自购返利入账',
  'ledger_type.SHARE_CREDIT.name': '分享收益入账',
  'ledger_type.REFERRAL_CREDIT.name': '邀请分佣入账',
  'ledger_type.REFERRAL_CREDIT.name_indirect': '好友推广奖励',
  'ledger_type.CLAWBACK.name': '订单扣回',
  'ledger_type.CLAWBACK.name_part_refund': '部分退款扣回',
  'ledger_type.SETTLE_ADJUST.name': '结算补差',
  'ledger_type.WITHDRAW_FREEZE.name': '提现冻结',
  'ledger_type.WITHDRAW_RETURN.name': '提现退回',
  'ledger_type.WITHDRAW_PAID.name': '提现到账',
  'ledger_type.WITHDRAW_FEE.name': '提现手续费',
  'ledger_type.TAX_WITHHOLD.name': '代扣个税',
  'ledger_type.BAD_DEBT_WRITEOFF.name': '负余额核销',
  'ledger_type.BAD_DEBT_WRITEOFF.hint': '余额为负的部分已由平台核销',
  'ledger_type.REWARD.name_invite': '邀请奖励',
  'ledger_type.REWARD.hint_invite': '邀请好友活动奖励',
  'ledger_type.ADMIN_ADJUST.name_RESTORE': '订单恢复补发',
  'ledger_type.ADMIN_ADJUST.hint_RESTORE': '订单经核实恢复，补发对应金额',
  'ledger_type.ADMIN_ADJUST.name_RECON_FIX': '结算核对更正',
  'ledger_type.ADMIN_ADJUST.hint_RECON_FIX': '按联盟结算核对结果更正',
  'ledger_type.ADMIN_ADJUST.name_PAYOUT_RECOVERY': '重复到账追回',
  'ledger_type.ADMIN_ADJUST.hint_PAYOUT_RECOVERY': '追回重复或异常到账的提现金额',
  'ledger_type.ADMIN_ADJUST.name_OTHER': '人工调账',
  'ledger_type.ADMIN_ADJUST.hint_OTHER': '如有疑问请联系客服',
  'ledger.balance_after': '余额 {amount}',
  'ledger.empty': '还没有余额变动',
  'ledger.empty.hint': '返利结算入账、提现等变动会显示在这里',
};

/** 字典有值用字典（含占位符填充），否则用包内默认；都没有返回空串。 */
export function ledgerText(key: string, params: Readonly<Record<string, string>> = {}): string {
  const contract = t(key, params);
  if (contract !== '') return contract;
  const local = Object.hasOwn(ledgerDefaults, key) ? ledgerDefaults[key] : undefined;
  if (local === undefined) return '';
  return local.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? (params[name] ?? whole) : whole,
  );
}

/** 08 没有字典键的页面文字（编排者登记补键）。 */
export const ledgerTexts = {
  /** 邀请分佣类（masked=true）流水的说明（BR-TEXT-19「邀请好友订单」）。 */
  referralHint: '邀请好友订单',
  /** WITHDRAW_PAID 汇总条目明细「手续费 {fee}」的标签（BR-TEXT-19 细则）。 */
  feeLabel: '手续费',
  /** 名称映射不到时的兜底名称（如 REWARD 的 newbie / checkin 尚未定文案）。 */
  unknownType: '余额变动',
  /** 月份分组标题。 */
  month: (year: string, month: string): string => `${year} 年 ${month} 月`,
  /** 全部加载完后的到底提示（画板 Ledger）。 */
  end: '没有更多记录了',
  /** 下一页加载失败；已显示的流水保留。 */
  moreFailed: '更多记录加载失败',
  retry: '重试',
  /** 下拉刷新进行中。 */
  refreshing: '正在刷新…',
} as const;
