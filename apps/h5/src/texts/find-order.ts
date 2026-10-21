// 订单找回页（F1-04b）的文案。已有键一律取契约字典 contracts/texts.default.json（经 shared/texts.ts 的 t()）：
// claim.guide.order_no / .paid_date / .window / .caution / .entry、error.30201～error.30206、
// error.30202.<reason>、error.30203.RISK_BLOCKED、error.20001、error.10405、buy.timeout、h5.load_failed。
// 字典还没有的键（规格 design/specs/app-find-order.md §7「待上游补键」）用这里的包内默认，占位措辞逐字取自
// 08 BR-TEXT-14 表 C 第 2 批行与画板 FindOrder-v2 / FindOrderRecords-v2 / FindOrderRecordsEmpty；
// 字典补上后以字典为准（t() 先查字典）。由编排者登记补键。
import { t } from '../shared/texts.ts';

/**
 * 字典缺键时的包内默认（§7 占位），键名与 08 表 C 同形：
 * - claim.records.empty：08 表 C 已有，contracts/texts.default.json 尚未收录；
 * - claim.records.status.* / .desc.* / .footer：08 表 C 第 2 批（画板 FindOrderRecords-v2）；
 * - claim_reject_reason.<CODE>.title：用户侧只起草了 NO_EVIDENCE、NOT_IN_POOL 两条（设计占位），其余待补；
 * - claim.result.*：CLAIM_RESULT 模板（BR-TEXT-09）在记录行的写法；记录接口没有返利金额，
 *   「预估返 {rebate}」不显示（不编造金额）。
 */
const findOrderDefaults: Readonly<Record<string, string>> = {
  'claim.records.empty': '还没有找回申请',
  'claim.records.status.pending': '审核中',
  'claim.records.status.auto_tracked': '已自动跟单',
  'claim.records.status.approved': '已找回',
  'claim.records.status.rejected': '未通过',
  'claim.records.desc.pending': '客服正在核对，结果会通过消息通知你',
  'claim.records.desc.auto_tracked': '这笔订单已同步到你的订单列表，无需再找回',
  'claim.records.footer': '只显示你本人提交的找回申请',
  'claim.result.approved': '订单找回成功',
  'claim.result.rejected': '订单找回未通过：{reason}',
  'claim_reject_reason.NO_EVIDENCE.title': '没有找到这笔订单经凑狸下单的记录',
  'claim_reject_reason.NOT_IN_POOL.title': '该订单已由平台记录归属，找回已关闭',
};

/** 字典有值用字典（含占位符填充），否则用包内默认；都没有返回空串。 */
export function findOrderText(key: string, params: Readonly<Record<string, string>> = {}): string {
  const contract = t(key, params);
  if (contract !== '') return contract;
  const local = Object.hasOwn(findOrderDefaults, key) ? findOrderDefaults[key] : undefined;
  if (local === undefined) return '';
  return local.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? (params[name] ?? whole) : whole,
  );
}

/** 08 没有字典键的页面文字（画板原文或代理起草的占位，由编排者登记补键）。 */
export const findOrderTexts = {
  /** 页签（画板 FindOrder-v2）。 */
  tabApply: '申请找回',
  tabRecords: '找回记录',
  /** 页签组的读屏名。 */
  tabsLabel: '订单找回',
  /** 表单顶部说明（画板 FindOrder-v2 原文）。 */
  intro:
    '在凑狸点了购买、但订单页没有这笔订单？填写下面的信息申请找回，客服核对后会通过消息通知你结果。',
  /** 字段标签（画板原文）。 */
  platformLabel: '下单平台',
  orderLabel: '订单号',
  paidDateLabel: '付款日期',
  /** 提交按钮（画板原文）。 */
  submit: '提交找回',
  /** 本地必填校验（代理起草的占位）。 */
  orderRequired: '请填写订单号',
  paidDateRequired: '请填写付款日期',
  /** 记录行（画板 FindOrderRecords-v2 写法）。 */
  orderNo: '订单号',
  paidDate: '付款日期',
  submittedAt: '提交于',
  subOrder: '子订单',
  /** 列表时间（BR-TEXT-11）。 */
  today: '今天',
  yesterday: '昨天',
  /** 驳回原因没有用户侧文字时的通用说明（代理起草的占位；不露原因码）。 */
  rejectGeneric: '这笔订单不符合找回条件，如有疑问请联系客服',
  /** 记录有下一页时的按钮与翻页失败提示（代理起草）。 */
  more: '查看更早的申请',
  moreFailed: '更早的申请加载失败，请重试',
} as const;
