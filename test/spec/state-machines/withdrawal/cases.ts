// 独立 oracle：SPEC_REF 038229e4，BR-WDR-08 正文与 W1–W11 表。
// 不从实现 YAML / 生成物计算期望。守卫只验证转写，不在本任务执行。
export const STATES = [
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'PAYING',
  'PAID_API',
  'PAID_MANUAL',
  'FAILED',
];

export const EVENTS = [
  'APPLY',
  'APPROVE',
  'REJECT',
  'EXECUTE',
  'CHANNEL_SUCCESS',
  'CHANNEL_FAIL',
  'CHANNEL_UNKNOWN',
  'MANUAL_PAID',
  'HOLD',
  'MANUAL_RESOLVE',
  'CHANNEL_SUCCESS_PROVEN',
];

interface Rule {
  id: string;
  from: (string | null)[];
  event: string;
  targets: string[];
  guard: string;
  qualifiers: string[];
}

export const RULES: Rule[] = [
  {
    id: 'W1',
    from: [null],
    event: 'APPLY',
    targets: ['PENDING_REVIEW'],
    guard: 'BR-WDR-03 全部通过',
    qualifiers: [],
  },
  {
    id: 'W2',
    from: ['PENDING_REVIEW'],
    event: 'APPROVE',
    targets: ['APPROVED'],
    guard:
      'BR-WDR-10；available_fen ≥ 0 且 blocked_reason 为空（BR-WDR-05 (a)）；风控冻结与 withdraw_holds 不影响审核通过',
    qualifiers: [],
  },
  {
    id: 'W3',
    from: ['PENDING_REVIEW', 'APPROVED'],
    event: 'REJECT',
    targets: ['REJECTED'],
    guard:
      '必填原因码；从 APPROVED 驳回时不得有 pending/success/unknown 转账尝试（BR-WDR-10）；hold_reason=payer_side_after_transfer 的单须先有一次查询结果为「订单不存在」或清单内的明确失败（BR-WDR-17）；系统驳回 NEGATIVE_BALANCE 只针对没有任何转账尝试的单（BR-WDR-05 (a)）',
    qualifiers: [],
  },
  {
    id: 'W4',
    from: ['APPROVED'],
    event: 'EXECUTE',
    targets: ['PAYING'],
    guard:
      'BR-WDR-11、12（含该单没有任何转账尝试、available_fen ≥ 0、blocked_reason 为空）；execute_seq +1',
    qualifiers: [],
  },
  {
    id: 'W5',
    from: ['PAYING'],
    event: 'CHANNEL_SUCCESS',
    targets: ['PAID_API'],
    guard: 'BR-WDR-14、28',
    qualifiers: ['needs_manual=false'],
  },
  {
    id: 'W6',
    from: ['PAYING'],
    event: 'CHANNEL_FAIL',
    targets: ['FAILED'],
    guard: 'BR-WDR-14、28',
    qualifiers: ['needs_manual=false'],
  },
  {
    id: 'W7',
    from: ['PAYING'],
    event: 'CHANNEL_UNKNOWN',
    targets: ['same'],
    guard: '—',
    qualifiers: [],
  },
  {
    id: 'W8',
    from: ['APPROVED'],
    event: 'MANUAL_PAID',
    targets: ['PAID_MANUAL'],
    guard:
      'BR-WDR-16；hold_reason=payer_side_after_transfer 的单须先有一次查询结果为「订单不存在」或清单内的明确失败（BR-WDR-17）',
    qualifiers: [],
  },
  {
    id: 'W9',
    from: ['PAYING'],
    event: 'HOLD',
    targets: ['APPROVED'],
    guard: '发出转账前复核未过（BR-WDR-13 ③），或转账返回付款方侧码（BR-WDR-17、28）',
    qualifiers: [],
  },
  {
    // 与 CT-04a R3/R12 一样：二参数生成器只存基准目标，业务分流由调用方负责。
    // 两个目标均来自原文，不擅自规定某一个是默认业务结果。
    id: 'W10',
    from: ['PAYING'],
    event: 'MANUAL_RESOLVE',
    targets: ['PAID_API', 'FAILED'],
    guard: 'BR-WDR-15',
    qualifiers: ['needs_manual=true'],
  },
  {
    id: 'W11',
    from: ['APPROVED'],
    event: 'CHANNEL_SUCCESS_PROVEN',
    targets: ['PAID_API'],
    guard:
      '该单唯一的转账尝试 result=fail；通道成功凭证（查询返回成功，或含该 out_biz_no 的账单行，金额 = net_fen）；有权限者 step-up（权限点同 W10 未知处置）；开关 payout.proven_success_writeoff.enabled=on',
    qualifiers: ['hold_reason=payer_side_after_transfer'],
  },
];
