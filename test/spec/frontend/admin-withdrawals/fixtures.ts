import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for the merged CT-24y (contracts/openapi.yaml, tag admin-withdrawals):
// listAdminWithdrawals GET /admin/v1/withdrawals and getAdminWithdrawal GET
// /admin/v1/withdrawals/{withdrawal_id}. The fake server checks in the order the descriptions
// give. Ids are obvious fake UUIDs; numbers, amounts, users and admins are samples; the payee is
// only ever the masked shape of the contract examples. Chinese names are transcribed from the
// console dictionary (contracts/texts.admin.default.json, BR-TEXT-25) as an independent oracle.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const LIST = '/admin/v1/withdrawals';

export const detailPath = (id: string): string => `${LIST}/${id}`;
/** The console route of a withdrawal's detail (resource withdrawals/{id}). */
export const detailRoute = (id: string): string => `withdrawals/${id}`;

export type Withdrawal = Schema<'AdminWithdrawalDetail'>;
export type WithdrawalRow = Schema<'AdminWithdrawalListItem'>;
export type WithdrawalStatus = Schema<'WithdrawalStatus'>;
export type RiskFlagCode = Schema<'AdminWithdrawalRiskFlagCode'>;

/** admin_dict.withdrawal_status.* */
export const STATUS_NAME: Readonly<Record<WithdrawalStatus, string>> = {
  PENDING_REVIEW: '待审核',
  APPROVED: '已通过待打款',
  REJECTED: '已驳回',
  PAYING: '打款中',
  PAID_API: '接口打款成功',
  PAID_MANUAL: '线下打款成功',
  FAILED: '打款失败',
};
/** admin_dict.withdrawals.review_mode.* */
export const REVIEW_MODE_NAME = { auto: '自动到账', manual: '人工审核' } as const;
/** admin_dict.withdrawals.auto_decision.failed_conditions.* (the codes used here). */
export const CONDITION_NAME = {
  max_amount: '超单笔自动上限',
  same_day: '当日入账当日提现',
  first_withdrawal: '首次提现',
} as const;
/** admin_dict.withdrawals.risk_flags.* (the codes used here). */
export const RISK_NAME: Readonly<Partial<Record<RiskFlagCode, string>>> = {
  first_withdrawal: '首次提现',
  same_device_multi_account: '同设备多账号',
  credited_today: '当日有入账',
  payee_prev_other_user: '收款账号曾属他人',
};

/** The payout channel as the page may show it (no admin_dict row: a name or the code). */
export const CHANNEL_SHOWN = {
  alipay: /支付宝|alipay/,
  bank_card: /银行卡|bank_card/,
  wechat: /微信|wechat/,
} as const;

export const ID = {
  /** PENDING_REVIEW, manual (转人工: max_amount + risk_flag:first_withdrawal), 暂停 mark. */
  pending: 'e1000001-0000-4000-8000-000000000001',
  /** PAID_API, auto (paid_auto_system), in an auto batch, one successful transfer. */
  autoPaid: 'e1000002-0000-4000-8000-000000000002',
  /** APPROVED, auto, bank card, fee and tax, 执行受阻, blocked batch item, a hold in effect. */
  approved: 'e1000003-0000-4000-8000-000000000003',
  /** REJECTED, manual, two risk flags, reviewed by REVIEWER. */
  rejected: 'e1000004-0000-4000-8000-000000000004',
  /** PAID_MANUAL, bank card, large amount with tax, in a manual batch. */
  manualPaid: 'e1000005-0000-4000-8000-000000000005',
  /** FAILED, executed by EXECUTOR, two transfer attempts. */
  failed: 'e1000006-0000-4000-8000-000000000006',
  /** PAYING, wechat, waiting for the user to confirm (BR-WDR-33). */
  paying: 'e1000007-0000-4000-8000-000000000007',
  /** Not a withdrawal of this app (20001 [withdrawal_id]). */
  unknown: 'e100dead-0000-4000-8000-0000000000ff',
} as const;
export const NO = {
  pending: 'W20261029000101',
  autoPaid: 'W20261028000102',
  approved: 'W20261027000103',
  rejected: 'W20261020000104',
  manualPaid: 'W20261010000105',
  failed: 'W20261005000106',
  paying: 'W20261025000107',
} as const;
export const USER = {
  a: 'c1000001-0000-4000-8000-000000000001',
  b: 'c1000002-0000-4000-8000-000000000002',
  c: 'c1000003-0000-4000-8000-000000000003',
} as const;
export const PHONE = { a: '138****5678', b: '139****1234', c: '137****0001' } as const;
/** The admin who reviewed the rejected and the manually paid samples. */
export const REVIEWER = 'ad000001-0000-4000-8000-0000000000a1';
/** The admin who executed the failed sample. */
export const EXECUTOR = 'ad000002-0000-4000-8000-0000000000a2';
export const BATCH = {
  autoPaid: 'b1000002-0000-4000-8000-000000000002',
  approved: 'b1000003-0000-4000-8000-000000000003',
  manualPaid: 'b1000005-0000-4000-8000-000000000005',
  failed: 'b1000006-0000-4000-8000-000000000006',
  paying: 'b1000007-0000-4000-8000-000000000007',
} as const;
export const HOLD_ID = 'a1000003-0000-4000-8000-000000000001';
export const HOLD_SOURCE = 'd1000001-0000-4000-8000-000000000001';
export const ATTEMPT = {
  autoPaid: 'a2000002-0000-4000-8000-000000000001',
  failedTransfer: 'a2000006-0000-4000-8000-000000000001',
  failedQuery: 'a2000006-0000-4000-8000-000000000002',
  paying: 'a2000007-0000-4000-8000-000000000001',
} as const;
/** Masked payee snapshots (BR-ID-33 shapes of the contract: `zh***@example.com`, `尾号 1234`, `**三`). */
export const PAYEE = {
  pending: { masked_account: 'zh***@example.com', masked_name: '**明', bank_name: null },
  autoPaid: { masked_account: 'wa***@example.com', masked_name: '**芳', bank_name: null },
  approved: { masked_account: '尾号 1234', masked_name: '**三', bank_name: '招商银行' },
  rejected: { masked_account: 'li***@example.com', masked_name: '**芳', bank_name: null },
  manualPaid: { masked_account: '尾号 9876', masked_name: '**华', bank_name: '中国工商银行' },
  failed: { masked_account: 'zh***@example.com', masked_name: '**明', bank_name: null },
  paying: { masked_account: '小**', masked_name: '**明', bank_name: null },
} as const;
export const REJECT_NOTE = '同设备多账号集中提现，内部核查中';

function blank(): Withdrawal {
  return {
    withdrawal_id: '',
    out_biz_no: '',
    user: { user_id: USER.a, phone_masked: PHONE.a },
    status: 'PENDING_REVIEW',
    display_status: 'pending_review',
    review_mode: 'manual',
    payout_channel: 'alipay',
    amount_fen: 0,
    fee_fen: 0,
    tax_fen: 0,
    net_fen: 0,
    auto_decision: null,
    hold_reason: null,
    blocked_reason: null,
    needs_manual: false,
    reject_reason_code: null,
    reject_note: null,
    reviewer_id: null,
    reviewed_at: null,
    batch_id: null,
    risk_flags: [],
    risk_flags_at: null,
    created_at: '2026-10-01T00:00:00+08:00',
    paid_at: null,
    payout_method: 'alipay',
    review_deadline: null,
    fail_code: null,
    executor_id: null,
    executed_at: null,
    execute_seq: 0,
    manual_resolution: null,
    resolver_ids: [],
    manual_entry_by: null,
    manual_confirm_by: null,
    hold_at: null,
    channel_state: null,
    confirm_deadline: null,
    channel_order_id: null,
    updated_at: '2026-10-01T00:00:00+08:00',
    row_version: 1,
    payee: { masked_account: '', masked_name: '', bank_name: null },
    batch: null,
    batch_items: [],
    payout_attempts: [],
    holds: [],
  };
}

const WARN_NONE = {
  high_commission_order_ratio_bp: 0,
  invalid_ratio_bp: 0,
  withdraw_received_ratio_bp: 0,
};

/** The seven samples, newest first (created_at descending, the list's order). */
export function samples(): Withdrawal[] {
  return [
    {
      ...blank(),
      withdrawal_id: ID.pending,
      out_biz_no: NO.pending,
      user: { user_id: USER.a, phone_masked: PHONE.a },
      status: 'PENDING_REVIEW',
      display_status: 'pending_review',
      review_mode: 'manual',
      payout_channel: 'alipay',
      payout_method: 'alipay',
      amount_fen: 50000,
      net_fen: 50000,
      auto_decision: {
        result: 'manual',
        failed_conditions: ['max_amount', 'risk_flag:first_withdrawal'],
        warn_values: {
          high_commission_order_ratio_bp: 1200,
          invalid_ratio_bp: 300,
          withdraw_received_ratio_bp: 4500,
        },
        rule_version: 3,
        decided_at: '2026-10-29T10:00:01+08:00',
        execute_blocked: null,
      },
      blocked_reason: 'NEGATIVE_BALANCE',
      risk_flags: [{ code: 'first_withdrawal', value: true, threshold: null }],
      risk_flags_at: '2026-10-29T10:00:00+08:00',
      created_at: '2026-10-29T10:00:00+08:00',
      review_deadline: '2026-10-30T10:00:00+08:00',
      updated_at: '2026-10-29T10:00:01+08:00',
      payee: { ...PAYEE.pending },
    },
    {
      ...blank(),
      withdrawal_id: ID.autoPaid,
      out_biz_no: NO.autoPaid,
      user: { user_id: USER.b, phone_masked: PHONE.b },
      status: 'PAID_API',
      display_status: 'paid_auto_system',
      review_mode: 'auto',
      payout_channel: 'alipay',
      payout_method: 'alipay',
      amount_fen: 2000,
      net_fen: 2000,
      auto_decision: {
        result: 'auto',
        failed_conditions: [],
        warn_values: { ...WARN_NONE, withdraw_received_ratio_bp: 2000 },
        rule_version: 3,
        decided_at: '2026-10-28T09:30:01+08:00',
        execute_blocked: null,
      },
      reviewed_at: '2026-10-28T09:30:01+08:00',
      batch_id: BATCH.autoPaid,
      risk_flags_at: '2026-10-28T09:30:00+08:00',
      created_at: '2026-10-28T09:30:00+08:00',
      paid_at: '2026-10-28T09:31:10+08:00',
      executed_at: '2026-10-28T09:30:02+08:00',
      execute_seq: 1,
      updated_at: '2026-10-28T09:31:10+08:00',
      payee: { ...PAYEE.autoPaid },
      batch: { batch_id: BATCH.autoPaid, kind: 'auto', created_at: '2026-10-28T09:30:01+08:00' },
      batch_items: [
        {
          batch_id: BATCH.autoPaid,
          result: 'paying',
          reason: null,
          moved_to_batch_id: null,
          at: '2026-10-28T09:30:02+08:00',
        },
      ],
      payout_attempts: [
        {
          attempt_id: ATTEMPT.autoPaid,
          kind: 'transfer',
          result: 'success',
          resp_code: 'SUCCESS',
          resp_sub_code: null,
          at: '2026-10-28T09:30:05+08:00',
        },
      ],
    },
    {
      ...blank(),
      withdrawal_id: ID.approved,
      out_biz_no: NO.approved,
      user: { user_id: USER.c, phone_masked: PHONE.c },
      status: 'APPROVED',
      display_status: 'pending_review',
      review_mode: 'auto',
      payout_channel: 'bank_card',
      payout_method: 'bank_card',
      amount_fen: 123456,
      fee_fen: 100,
      tax_fen: 2345,
      net_fen: 121011,
      auto_decision: {
        result: 'auto',
        failed_conditions: [],
        warn_values: {
          high_commission_order_ratio_bp: null,
          invalid_ratio_bp: null,
          withdraw_received_ratio_bp: 1500,
        },
        rule_version: 3,
        decided_at: '2026-10-27T11:00:01+08:00',
        execute_blocked: 'watermark_below_forecast',
      },
      reviewed_at: '2026-10-27T11:00:01+08:00',
      batch_id: BATCH.approved,
      risk_flags_at: '2026-10-27T11:00:00+08:00',
      created_at: '2026-10-27T11:00:00+08:00',
      updated_at: '2026-10-27T11:00:02+08:00',
      row_version: 2,
      payee: { ...PAYEE.approved },
      batch: { batch_id: BATCH.approved, kind: 'auto', created_at: '2026-10-27T11:00:01+08:00' },
      batch_items: [
        {
          batch_id: BATCH.approved,
          result: 'blocked',
          reason: 'watermark_below_forecast',
          moved_to_batch_id: null,
          at: '2026-10-27T11:00:02+08:00',
        },
      ],
      holds: [
        {
          hold_id: HOLD_ID,
          reason: 'recon_diff',
          source_ref: HOLD_SOURCE,
          created_at: '2026-10-21T01:05:00+08:00',
          hold_until: null,
        },
      ],
    },
    {
      ...blank(),
      withdrawal_id: ID.paying,
      out_biz_no: NO.paying,
      user: { user_id: USER.a, phone_masked: PHONE.a },
      status: 'PAYING',
      display_status: 'paying',
      review_mode: 'auto',
      payout_channel: 'wechat',
      payout_method: 'wechat',
      amount_fen: 10000,
      net_fen: 10000,
      auto_decision: {
        result: 'auto',
        failed_conditions: [],
        warn_values: { ...WARN_NONE },
        rule_version: 3,
        decided_at: '2026-10-25T14:00:01+08:00',
        execute_blocked: null,
      },
      reviewed_at: '2026-10-25T14:00:01+08:00',
      batch_id: BATCH.paying,
      risk_flags_at: '2026-10-25T14:00:00+08:00',
      created_at: '2026-10-25T14:00:00+08:00',
      executed_at: '2026-10-25T14:00:03+08:00',
      execute_seq: 1,
      channel_state: 'wait_user_confirm',
      confirm_deadline: '2026-10-26T14:00:05+08:00',
      updated_at: '2026-10-25T14:00:05+08:00',
      payee: { ...PAYEE.paying },
      batch: { batch_id: BATCH.paying, kind: 'auto', created_at: '2026-10-25T14:00:01+08:00' },
      batch_items: [
        {
          batch_id: BATCH.paying,
          result: 'paying',
          reason: null,
          moved_to_batch_id: null,
          at: '2026-10-25T14:00:03+08:00',
        },
      ],
      payout_attempts: [
        {
          attempt_id: ATTEMPT.paying,
          kind: 'transfer',
          result: 'pending',
          resp_code: null,
          resp_sub_code: null,
          at: '2026-10-25T14:00:05+08:00',
        },
      ],
    },
    {
      ...blank(),
      withdrawal_id: ID.rejected,
      out_biz_no: NO.rejected,
      user: { user_id: USER.b, phone_masked: PHONE.b },
      status: 'REJECTED',
      display_status: 'rejected',
      review_mode: 'manual',
      payout_channel: 'alipay',
      payout_method: 'alipay',
      amount_fen: 30000,
      net_fen: 30000,
      auto_decision: {
        result: 'manual',
        failed_conditions: ['same_day'],
        warn_values: { ...WARN_NONE },
        rule_version: 3,
        decided_at: '2026-10-20T08:00:01+08:00',
        execute_blocked: null,
      },
      reject_reason_code: 'RISK_SUSPECT',
      reject_note: REJECT_NOTE,
      reviewer_id: REVIEWER,
      reviewed_at: '2026-10-20T15:30:00+08:00',
      risk_flags: [
        { code: 'same_device_multi_account', value: true, threshold: null },
        { code: 'credited_today', value: true, threshold: null },
      ],
      risk_flags_at: '2026-10-20T08:00:00+08:00',
      created_at: '2026-10-20T08:00:00+08:00',
      review_deadline: '2026-10-21T08:00:00+08:00',
      updated_at: '2026-10-20T15:30:00+08:00',
      row_version: 2,
      payee: { ...PAYEE.rejected },
    },
    {
      ...blank(),
      withdrawal_id: ID.manualPaid,
      out_biz_no: NO.manualPaid,
      user: { user_id: USER.c, phone_masked: PHONE.c },
      status: 'PAID_MANUAL',
      display_status: 'paid_manual',
      review_mode: 'manual',
      payout_channel: 'bank_card',
      payout_method: 'bank_card',
      amount_fen: 123456789,
      fee_fen: 0,
      tax_fen: 2469136,
      net_fen: 120987653,
      auto_decision: {
        result: 'manual',
        failed_conditions: ['max_amount'],
        warn_values: { ...WARN_NONE },
        rule_version: 2,
        decided_at: '2026-10-10T16:00:01+08:00',
        execute_blocked: null,
      },
      reviewer_id: REVIEWER,
      reviewed_at: '2026-10-10T17:00:00+08:00',
      batch_id: BATCH.manualPaid,
      risk_flags: [{ code: 'payee_prev_other_user', value: true, threshold: null }],
      risk_flags_at: '2026-10-10T16:00:00+08:00',
      created_at: '2026-10-10T16:00:00+08:00',
      paid_at: '2026-10-11T10:20:00+08:00',
      manual_entry_by: REVIEWER,
      manual_confirm_by: REVIEWER,
      channel_order_id: 'BANKSERIAL0005',
      updated_at: '2026-10-11T10:20:00+08:00',
      row_version: 4,
      payee: { ...PAYEE.manualPaid },
      batch: {
        batch_id: BATCH.manualPaid,
        kind: 'manual',
        created_at: '2026-10-11T09:00:00+08:00',
      },
      batch_items: [
        {
          batch_id: BATCH.manualPaid,
          result: 'paying',
          reason: null,
          moved_to_batch_id: null,
          at: '2026-10-11T09:00:00+08:00',
        },
      ],
    },
    {
      ...blank(),
      withdrawal_id: ID.failed,
      out_biz_no: NO.failed,
      user: { user_id: USER.a, phone_masked: PHONE.a },
      status: 'FAILED',
      display_status: 'failed',
      review_mode: 'auto',
      payout_channel: 'alipay',
      payout_method: 'alipay',
      amount_fen: 8800,
      net_fen: 8800,
      auto_decision: {
        result: 'auto',
        failed_conditions: [],
        warn_values: { ...WARN_NONE },
        rule_version: 2,
        decided_at: '2026-10-05T09:00:01+08:00',
        execute_blocked: null,
      },
      reviewed_at: '2026-10-05T09:00:01+08:00',
      batch_id: BATCH.failed,
      risk_flags_at: '2026-10-05T09:00:00+08:00',
      created_at: '2026-10-05T09:00:00+08:00',
      fail_code: 'PAYEE_NOT_EXIST',
      executor_id: EXECUTOR,
      executed_at: '2026-10-05T09:01:00+08:00',
      execute_seq: 1,
      updated_at: '2026-10-05T09:06:00+08:00',
      row_version: 3,
      payee: { ...PAYEE.failed },
      batch: { batch_id: BATCH.failed, kind: 'manual', created_at: '2026-10-05T09:00:30+08:00' },
      batch_items: [
        {
          batch_id: BATCH.failed,
          result: 'paying',
          reason: null,
          moved_to_batch_id: null,
          at: '2026-10-05T09:01:00+08:00',
        },
      ],
      payout_attempts: [
        {
          attempt_id: ATTEMPT.failedTransfer,
          kind: 'transfer',
          result: 'fail',
          resp_code: 'PAYEE_NOT_EXIST',
          resp_sub_code: 'PAYEE_USER_INFO_ERROR',
          at: '2026-10-05T09:01:05+08:00',
        },
        {
          attempt_id: ATTEMPT.failedQuery,
          kind: 'query',
          result: 'fail',
          resp_code: 'ORDER_FAIL',
          resp_sub_code: null,
          at: '2026-10-05T09:06:00+08:00',
        },
      ],
    },
  ];
}

/** `count` older PENDING_REVIEW rows after the samples (for paging; numbers W2026070100nnnn). */
export function withFiller(count: number): Withdrawal[] {
  const filler = Array.from({ length: count }, (_, index): Withdrawal => {
    const n = String(index + 1).padStart(4, '0');
    return {
      ...blank(),
      withdrawal_id: `f0000000-0000-4000-8000-00000000${n}`,
      out_biz_no: `W2026070100${n}`,
      amount_fen: 100,
      net_fen: 100,
      created_at: '2026-07-01T09:00:00+08:00',
      updated_at: '2026-07-01T09:00:00+08:00',
      payee: { ...PAYEE.pending },
    };
  });
  return [...samples(), ...filler];
}
/** The out_biz_no of filler row `n` (1-based) of withFiller. */
export const fillerNo = (n: number): string => `W2026070100${String(n).padStart(4, '0')}`;

/** Permission points an account holds. */
export type Grants = readonly KnownPermission[];
/** withdraw.review: reads (the writes of this point are not part of this page). */
export const REVIEW_GRANTS: Grants = ['withdraw.review'];
/** fund.view: reads only; the menu stays hidden (it shows for withdraw.review / payout.*). */
export const VIEW_GRANTS: Grants = ['fund.view'];
/** Every write point a full finance account could hold, on top of reading. */
export const ALL_GRANTS: Grants = [
  'withdraw.review',
  'fund.view',
  'payout.execute',
  'payout.manual_entry',
  'export',
  'config.business',
];
/** Neither withdraw.review nor fund.view. */
export const OTHER_GRANTS: Grants = ['user.lookup'];

/** Permission snapshot; this read-only page needs no step-up. */
export function snapshot(permissions: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of permissions) stepUp[point] = { tier: null, operations: {} };
  return { isSuper: false, permissions, stepUp };
}

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
// HTTP statuses as in contracts/error-codes.yaml.
const STATUS: Record<number, number> = {
  10001: 401,
  10403: 403,
  20001: 400,
  50001: 500,
};
/** An error envelope; `data` is left out when undefined. */
export function failure(code: number, data?: unknown, msg = '参数错误'): Response {
  const envelope: Record<string, unknown> = { code, msg, trace_id: TRACE_ID };
  if (data !== undefined) envelope['data'] = data;
  return Response.json(envelope, { status: STATUS[code] ?? 400 });
}
export function rejected(fields: readonly string[]): Response {
  return failure(20001, { fields });
}
export function denied(): Response {
  return failure(10403, { reason: 'admin_permission_denied' }, '无权限');
}

export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;

export interface ServerOptions {
  /** Permission points of the account (the server checks them; 10403 otherwise). */
  readonly permissions?: Grants;
}

const STATUSES: readonly string[] = Object.keys(STATUS_NAME);
const DISPLAY_STATUSES: readonly string[] = [
  'pending_review',
  'pending_handle',
  'rejected',
  'paid_manual',
  'paid_auto_system',
  'paid_auto_review',
  'paying',
  'failed',
];
const REVIEW_MODES: readonly string[] = ['auto', 'manual'];
const CHANNELS: readonly string[] = ['alipay', 'bank_card', 'wechat'];
const HOLD_REASONS: readonly string[] = [
  'payout_disabled',
  'queue_paused',
  'channel_disabled',
  'member_blocked',
  'single_cap',
  'daily_cap',
  'payer_side_after_transfer',
];
const RISK_CODES: readonly string[] = [
  'first_withdrawal',
  'credited_today',
  'same_device_multi_account',
  'invalid_ratio_60d',
  'high_commission_ratio_60d',
  'withdraw_vs_received',
  'had_negative',
  'recon_diff',
  'blacklist_hit',
  'payee_prev_other_user',
  'risk_calc_failed',
];
const POSITIVE = /^[1-9][0-9]*$/;
const NON_NEGATIVE = /^(?:0|[1-9][0-9]*)$/;
const OUT_BIZ_NO = /^[A-Za-z0-9]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO 8601 date-time with an offset (04 §5). */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Every query parameter listAdminWithdrawals takes. */
export const LIST_PARAMS: readonly string[] = [
  'page',
  'page_size',
  'status',
  'display_status',
  'review_mode',
  'payout_channel',
  'user_id',
  'out_biz_no',
  'amount_min_fen',
  'amount_max_fen',
  'created_from',
  'created_to',
  'hold_reason',
  'blocked',
  'risk_flag',
];
/** The filter parameters (everything but paging). */
export const FILTER_PARAMS: readonly string[] = LIST_PARAMS.slice(2);
const DETAIL = /^\/admin\/v1\/withdrawals\/([^/]+)$/;

/** A list row: the detail without the detail-only fields (no payee in a row). */
export function rowOf(item: Withdrawal): WithdrawalRow {
  return {
    withdrawal_id: item.withdrawal_id,
    out_biz_no: item.out_biz_no,
    user: item.user,
    status: item.status,
    display_status: item.display_status,
    review_mode: item.review_mode,
    payout_channel: item.payout_channel,
    amount_fen: item.amount_fen,
    fee_fen: item.fee_fen,
    tax_fen: item.tax_fen,
    net_fen: item.net_fen,
    auto_decision: item.auto_decision,
    hold_reason: item.hold_reason,
    blocked_reason: item.blocked_reason,
    needs_manual: item.needs_manual,
    reject_reason_code: item.reject_reason_code,
    reject_note: item.reject_note,
    reviewer_id: item.reviewer_id,
    reviewed_at: item.reviewed_at,
    batch_id: item.batch_id,
    risk_flags: item.risk_flags,
    risk_flags_at: item.risk_flags_at,
    created_at: item.created_at,
    paid_at: item.paid_at,
  };
}
function newestFirst(a: Withdrawal, b: Withdrawal): number {
  const time = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (time !== 0) return time;
  return a.withdrawal_id < b.withdrawal_id ? 1 : a.withdrawal_id > b.withdrawal_id ? -1 : 0;
}
const oneOf = (value: string | undefined, values: readonly string[]): boolean =>
  value === undefined || values.includes(value);
const matches = (value: string | undefined, pattern: RegExp): boolean =>
  value === undefined || pattern.test(value);

/** Fake /admin/v1 server with the CT-24y checks. */
export function createServer(initial: Withdrawal[] = samples(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  const permissions = options.permissions ?? REVIEW_GRANTS;
  let inFlight = 0;

  const canRead = (): boolean =>
    permissions.includes('withdraw.review') || permissions.includes('fund.view');
  const find = (id: string): Withdrawal | undefined =>
    state.find((item) => item.withdrawal_id === id);

  function list(query: Record<string, string>): Response {
    if (!canRead()) return denied();
    const q = query;
    const size = q['page_size'];
    const invalid = [
      ...(matches(q['page'], POSITIVE) ? [] : ['page']),
      ...(size === undefined || (POSITIVE.test(size) && Number(size) <= 200) ? [] : ['page_size']),
      ...(oneOf(q['status'], STATUSES) ? [] : ['status']),
      ...(oneOf(q['display_status'], DISPLAY_STATUSES) ? [] : ['display_status']),
      ...(oneOf(q['review_mode'], REVIEW_MODES) ? [] : ['review_mode']),
      ...(oneOf(q['payout_channel'], CHANNELS) ? [] : ['payout_channel']),
      ...(matches(q['user_id'], UUID) ? [] : ['user_id']),
      ...(matches(q['out_biz_no'], OUT_BIZ_NO) ? [] : ['out_biz_no']),
      ...(matches(q['amount_min_fen'], NON_NEGATIVE) ? [] : ['amount_min_fen']),
      ...(matches(q['amount_max_fen'], NON_NEGATIVE) ? [] : ['amount_max_fen']),
      ...(matches(q['created_from'], DATE_TIME) ? [] : ['created_from']),
      ...(matches(q['created_to'], DATE_TIME) ? [] : ['created_to']),
      ...(oneOf(q['hold_reason'], HOLD_REASONS) ? [] : ['hold_reason']),
      ...(oneOf(q['blocked'], ['true', 'false']) ? [] : ['blocked']),
      ...(oneOf(q['risk_flag'], RISK_CODES) ? [] : ['risk_flag']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    const min = q['amount_min_fen'] === undefined ? undefined : Number(q['amount_min_fen']);
    const max = q['amount_max_fen'] === undefined ? undefined : Number(q['amount_max_fen']);
    if (min !== undefined && max !== undefined && min > max)
      return rejected(['amount_min_fen', 'amount_max_fen']);
    const from = q['created_from'] === undefined ? undefined : Date.parse(q['created_from']);
    const to = q['created_to'] === undefined ? undefined : Date.parse(q['created_to']);
    if (from !== undefined && to !== undefined && from > to)
      return rejected(['created_from', 'created_to']);
    const matching = state
      .filter((item) => {
        const created = Date.parse(item.created_at);
        return (
          (q['status'] === undefined || item.status === q['status']) &&
          (q['display_status'] === undefined || item.display_status === q['display_status']) &&
          (q['review_mode'] === undefined || item.review_mode === q['review_mode']) &&
          (q['payout_channel'] === undefined || item.payout_channel === q['payout_channel']) &&
          (q['user_id'] === undefined || item.user.user_id === q['user_id']) &&
          (q['out_biz_no'] === undefined || item.out_biz_no === q['out_biz_no']) &&
          (min === undefined || item.amount_fen >= min) &&
          (max === undefined || item.amount_fen <= max) &&
          (from === undefined || created >= from) &&
          (to === undefined || created < to) &&
          (q['hold_reason'] === undefined || item.hold_reason === q['hold_reason']) &&
          (q['blocked'] === undefined ||
            (item.blocked_reason !== null) === (q['blocked'] === 'true')) &&
          (q['risk_flag'] === undefined ||
            item.risk_flags.some((flag) => flag.code === q['risk_flag']))
        );
      })
      .sort(newestFirst);
    const pageNo = q['page'] === undefined ? 1 : Number(q['page']);
    const pageSize = size === undefined ? 20 : Number(size);
    const items = matching.slice((pageNo - 1) * pageSize, pageNo * pageSize).map(rowOf);
    return ok({ items, page: pageNo, page_size: pageSize, total: matching.length });
  }

  function detail(id: string): Response {
    if (!canRead()) return denied();
    const found = find(id);
    if (found === undefined) return rejected(['withdrawal_id']);
    return ok(found);
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token') {
      return failure(10001, undefined, '未登录');
    }
    if (method === 'GET' && path === LIST) return list(request.query);
    const one = DETAIL.exec(path);
    if (method === 'GET' && one !== null) return detail(decodeURIComponent(one[1]!));
    return rejected(['path']);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const request: RequestLog = {
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      body: typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : undefined,
    };
    log.push(request);
    inFlight += 1;
    try {
      const index = overrides.findIndex(
        (entry) => entry.method === request.method && entry.path === request.path,
      );
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
    } finally {
      inFlight -= 1;
    }
  };

  return {
    state,
    log,
    fetch,
    permissions,
    get pending() {
      return inFlight;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    /** GET /admin/v1/withdrawals (the list). */
    reads() {
      return log.filter((r) => r.method === 'GET' && r.path === LIST);
    },
    /** GET /admin/v1/withdrawals/{id} (every id when none is given). */
    detailReads(id?: string) {
      return log.filter(
        (r) =>
          r.method === 'GET' &&
          (id === undefined ? DETAIL.test(r.path) : r.path === detailPath(id)),
      );
    },
    /** Every request to /admin/v1/withdrawals or below it. */
    withdrawalRequests() {
      return log.filter((r) => r.path === LIST || r.path.startsWith(`${LIST}/`));
    },
    /** Every request that is not a GET. */
    writes() {
      return log.filter((r) => r.method !== 'GET');
    },
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
    hold(method: string, path: string, reply: Reply = normal) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        reply: async (request) => {
          await gate.promise;
          return reply(request);
        },
      });
      return gate.resolve;
    },
  };
}
export type Server = ReturnType<typeof createServer>;
