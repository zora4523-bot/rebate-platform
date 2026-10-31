import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.admin.default.json' with { type: 'json' };
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for the user detail tabs (F1-07jb): adminGetUser / lookup, and the three
// lists the tabs read with `user_id` — adminListOrders GET /admin/v1/orders, adminListClaims GET
// /admin/v1/claims and listAdminWithdrawals GET /admin/v1/withdrawals. Every id is an obviously
// fake UUID; numbers, amounts and times are samples. The fake server checks the permission rules
// of each description itself (order.view, or user.lookup only together with user_id; order.claim,
// or user.lookup only together with user_id; withdraw.review or fund.view), so a page that reads
// a list it may not read gets the contract's 10403.

export const BASE_URL = 'https://admin-api.example.test';
const TRACE_ID = '00000000-0000-4000-8000-00000000a0a0';

export const USERS = '/admin/v1/users';
export const LOOKUP = `${USERS}/lookup`;
export const ORDERS = '/admin/v1/orders';
export const CLAIMS = '/admin/v1/claims';
export const WITHDRAWALS = '/admin/v1/withdrawals';
export const LISTS = [ORDERS, CLAIMS, WITHDRAWALS] as const;

/** The user looked at in most cases. */
export const UID = 'aaaaaaaa-0000-4000-8000-000000000001';
/** UID's inviter (the 上级 link of the overview opens this user). */
export const PARENT = 'aaaaaaaa-0000-4000-8000-000000000002';
/** A user without any order, claim or withdrawal. */
export const QUIET = 'aaaaaaaa-0000-4000-8000-000000000003';
/** Invite code of each user: shown once that user's detail is loaded. */
export const INVITE: Readonly<Record<string, string>> = {
  [UID]: 'INVUID',
  [PARENT]: 'INVPAR',
  [QUIET]: 'INVQUI',
};

export type UserRow = Schema<'AdminUserListItem'>;
export type UserDetail = Schema<'AdminUserDetail'>;
export type OrderRow = Schema<'AdminOrderListItem'>;
export type ClaimRow = Schema<'AdminClaimListItem'>;
export type WithdrawalRow = Schema<'AdminWithdrawalListItem'>;

export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };
export function grants(...permissions: string[]): PermissionSnapshot {
  return { isSuper: false, permissions };
}

// ---- console dictionary (BR-TEXT-25), read at run time --------------------------------------

const TEXTS: Readonly<Record<string, string>> = dictionary.texts;

/** admin_dict.<kind>.<code> from the bundled console dictionary; the code while it has no row. */
export function dictName(kind: string, code: string): string {
  const name = `admin_dict.${kind}.${code}`;
  return Object.hasOwn(TEXTS, name) ? TEXTS[name]! : code;
}

// ---- amounts (BR-TEXT-10 admin format, worked out by hand from integer fen) ------------------

/** 「-¥1,234.56」: minus sign kept in front of ¥, thousands grouped, exactly two decimals. */
export function yuan(fen: number): string {
  const sign = fen < 0 ? '-' : '';
  const magnitude = Math.abs(fen);
  const whole = String(Math.trunc(magnitude / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}¥${whole}.${String(magnitude % 100).padStart(2, '0')}`;
}

/** How a platform may show: its Chinese name or its code. */
export const PLATFORM_SHOWN: Readonly<Record<string, RegExp>> = {
  taobao: /淘宝|taobao/,
  jd: /京东|jd/,
  pdd: /拼多多|pdd/,
};

// ---- users ----------------------------------------------------------------------------------

export function users(): UserRow[] {
  return [
    {
      user_id: UID,
      nickname: '页签用户甲',
      phone_masked: '138****0001',
      level: 'L2',
      risk_state: 'normal',
      created_at: '2026-08-06T02:00:00Z',
    },
    {
      user_id: PARENT,
      nickname: '页签用户乙',
      phone_masked: '139****0002',
      level: 'L1',
      risk_state: 'normal',
      created_at: '2026-07-01T02:00:00Z',
    },
    {
      user_id: QUIET,
      nickname: '页签用户丙',
      phone_masked: null,
      level: 'L1',
      risk_state: 'normal',
      created_at: '2026-09-01T02:00:00Z',
    },
  ];
}

export function userDetail(row: UserRow): UserDetail {
  return {
    user_id: row.user_id,
    nickname: row.nickname,
    phone_masked: row.phone_masked,
    invite_code: INVITE[row.user_id] ?? 'INVXXX',
    inviter_user_id: row.user_id === UID ? PARENT : null,
    level: row.level,
    register_method: 'sms',
    registered_channel: null,
    created_at: row.created_at,
    risk: {
      state: row.risk_state,
      reason_category: null,
      reason: null,
      frozen_until: null,
      changed_by: null,
      changed_at: null,
      row_version: null,
    },
    union_bindings: [
      {
        platform: 'taobao',
        status: 'active',
        blocked_reason: null,
        bound_at: '2026-08-06T03:00:00Z',
        released_at: null,
        cooldown_until: null,
        reason: null,
        row_version: 0,
      },
    ],
  };
}

// ---- orders ---------------------------------------------------------------------------------

const NO_FLAGS = { locked: false, status_locked: false, rights_pending: false, hold: false };

/**
 * UID's sub-orders, newest paid first. Every amount differs from every other one (pay amount,
 * union commission estimate and settled commission), and one pay amount is negative.
 */
export function uidOrders(): OrderRow[] {
  return [
    {
      order_id: 'bbbbbbbb-0000-4000-8000-000000000001',
      sub_order_id: '260930-1000000001',
      parent_order_id: '260930-1000000000',
      platform: 'taobao',
      title: '页签测试商品一',
      image_url: null,
      user: { user_id: UID, phone_masked: '138****0001' },
      // Beijing 2026-10-07 01:05:12 (the next calendar day).
      paid_at: '2026-10-06T17:05:12Z',
      pay_amount_fen: 1234567,
      est_commission_fen: 2468,
      settle_commission_fen: 1357,
      platform_status: 'SETTLED',
      rebate_status: 'CREDITED',
      hold_reason: null,
      flags: { ...NO_FLAGS, status_locked: true },
    },
    {
      order_id: 'bbbbbbbb-0000-4000-8000-000000000002',
      sub_order_id: '260930-1000000002',
      parent_order_id: null,
      platform: 'jd',
      title: '页签测试商品二',
      image_url: null,
      user: { user_id: UID, phone_masked: '138****0001' },
      // Beijing 2026-10-06 00:30:00.
      paid_at: '2026-10-05T16:30:00Z',
      pay_amount_fen: -4321,
      est_commission_fen: 975,
      settle_commission_fen: null,
      platform_status: 'PAID',
      rebate_status: 'ESTIMATED',
      hold_reason: null,
      flags: NO_FLAGS,
    },
    {
      order_id: 'bbbbbbbb-0000-4000-8000-000000000003',
      sub_order_id: '260930-1000000003',
      parent_order_id: null,
      platform: 'pdd',
      title: null,
      image_url: null,
      user: { user_id: UID, phone_masked: '138****0001' },
      // Beijing 2026-10-04 19:45:00.
      paid_at: '2026-10-04T11:45:00Z',
      pay_amount_fen: 880,
      est_commission_fen: 64,
      settle_commission_fen: null,
      platform_status: 'RECEIVED',
      rebate_status: 'WAITING',
      hold_reason: null,
      flags: NO_FLAGS,
    },
  ];
}

/** PARENT's only sub-order (no number or amount shared with UID's). */
export function parentOrders(): OrderRow[] {
  return [
    {
      order_id: 'bbbbbbbb-0000-4000-8000-000000000201',
      sub_order_id: '260930-2000000001',
      parent_order_id: null,
      platform: 'pdd',
      title: '页签测试商品上级',
      image_url: null,
      user: { user_id: PARENT, phone_masked: '139****0002' },
      paid_at: '2026-10-03T04:00:00Z',
      pay_amount_fen: 5555,
      est_commission_fen: 444,
      settle_commission_fen: null,
      platform_status: 'PAID',
      rebate_status: 'ESTIMATED',
      hold_reason: null,
      flags: NO_FLAGS,
    },
  ];
}

/** 205 sub-orders of UID (more than one page at any page_size ≤ 200). */
export function manyUidOrders(): OrderRow[] {
  return Array.from({ length: 205 }, (_, index) => ({
    ...uidOrders()[0]!,
    order_id: `bbbbbbbb-0000-4000-8000-${String(index + 1000).padStart(12, '0')}`,
    sub_order_id: `260930-${String(3000000000 + index)}`,
  }));
}

// ---- claims ---------------------------------------------------------------------------------

/** UID's claims (the display number of a claim is its claim_id). */
export function uidClaims(): ClaimRow[] {
  return [
    {
      claim_id: 'cccccccc-0000-4000-8000-000000000001',
      order_no: '260930-1000000091',
      platform: 'taobao',
      user: { user_id: UID, phone_masked: '138****0001' },
      paid_date: '2026-10-05',
      // Beijing 2026-10-12 00:20:00 (the next calendar day).
      submitted_at: '2026-10-11T16:20:00Z',
      evidence_level: 'strong',
      status: 'approved',
    },
    {
      claim_id: 'cccccccc-0000-4000-8000-000000000002',
      order_no: '260930-1000000092',
      platform: 'jd',
      user: { user_id: UID, phone_masked: '138****0001' },
      paid_date: '2026-10-04',
      // Beijing 2026-10-10 11:00:00.
      submitted_at: '2026-10-10T03:00:00Z',
      evidence_level: 'weak',
      status: 'manual_review',
    },
  ];
}

/** 205 claims of UID (more than one page at any page_size ≤ 200). */
export function manyUidClaims(): ClaimRow[] {
  return Array.from({ length: 205 }, (_, index) => ({
    ...uidClaims()[0]!,
    claim_id: `cccccccc-0000-4000-8000-${String(index + 1000).padStart(12, '0')}`,
    order_no: `260930-${String(4000000000 + index)}`,
  }));
}

export function parentClaims(): ClaimRow[] {
  return [
    {
      claim_id: 'cccccccc-0000-4000-8000-000000000201',
      order_no: '260930-2000000091',
      platform: 'pdd',
      user: { user_id: PARENT, phone_masked: '139****0002' },
      paid_date: '2026-10-02',
      submitted_at: '2026-10-02T06:00:00Z',
      evidence_level: 'none',
      status: 'rejected',
    },
  ];
}

// ---- withdrawals ----------------------------------------------------------------------------

function withdrawal(patch: Partial<WithdrawalRow> & Pick<WithdrawalRow, 'withdrawal_id'>) {
  const row: WithdrawalRow = {
    out_biz_no: 'W20260101000000',
    user: { user_id: UID, phone_masked: '138****0001' },
    status: 'PENDING_REVIEW',
    display_status: 'pending_review',
    review_mode: 'manual',
    payout_channel: 'alipay',
    amount_fen: 100,
    fee_fen: 0,
    tax_fen: 0,
    net_fen: 100,
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
    created_at: '2026-10-01T00:00:00Z',
    paid_at: null,
    ...patch,
  };
  return row;
}

/** UID's withdrawals, newest applied first; amount, fee, tax and net all differ. */
export function uidWithdrawals(): WithdrawalRow[] {
  return [
    withdrawal({
      withdrawal_id: 'dddddddd-0000-4000-8000-000000000001',
      out_biz_no: 'W20261021000001',
      status: 'PAID_API',
      display_status: 'paid_auto_system',
      review_mode: 'auto',
      amount_fen: 1234500,
      fee_fen: 1500,
      tax_fen: 2345,
      net_fen: 1230655,
      // Beijing 2026-10-21 03:47:00: another minute than the application and the payout.
      reviewed_at: '2026-10-20T19:47:00Z',
      // Beijing 2026-10-21 02:30:00 (the next calendar day).
      created_at: '2026-10-20T18:30:00Z',
      // Beijing 2026-10-21 04:12:00.
      paid_at: '2026-10-20T20:12:00Z',
    }),
    withdrawal({
      withdrawal_id: 'dddddddd-0000-4000-8000-000000000002',
      out_biz_no: 'W20261019000002',
      status: 'PENDING_REVIEW',
      display_status: 'pending_review',
      review_mode: 'manual',
      amount_fen: 67800,
      fee_fen: 300,
      tax_fen: 0,
      net_fen: 67500,
      // Beijing 2026-10-19 10:00:00.
      created_at: '2026-10-19T02:00:00Z',
    }),
  ];
}

/** 205 withdrawals of UID (more than one page at any page_size ≤ 200). */
export function manyUidWithdrawals(): WithdrawalRow[] {
  return Array.from({ length: 205 }, (_, index) => ({
    ...uidWithdrawals()[0]!,
    withdrawal_id: `dddddddd-0000-4000-8000-${String(index + 1000).padStart(12, '0')}`,
    out_biz_no: `W${String(20260900000000 + index)}`,
  }));
}

export function parentWithdrawals(): WithdrawalRow[] {
  return [
    withdrawal({
      withdrawal_id: 'dddddddd-0000-4000-8000-000000000201',
      out_biz_no: 'W20261018000201',
      user: { user_id: PARENT, phone_masked: '139****0002' },
      status: 'REJECTED',
      display_status: 'rejected',
      amount_fen: 9900,
      fee_fen: 0,
      tax_fen: 0,
      net_fen: 9900,
      created_at: '2026-10-18T01:00:00Z',
    }),
  ];
}

// ---- fake HTTP boundary ---------------------------------------------------------------------

export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
const HTTP_STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10403: 403,
  20001: 400,
  50001: 500,
};
export function failure(code: number, data: unknown = null, msg = '操作失败'): Response {
  return Response.json(
    { code, msg, data, trace_id: TRACE_ID },
    { status: HTTP_STATUS[code] ?? 400 },
  );
}
export function denied(): Response {
  return failure(10403, { reason: 'admin_permission_denied' }, '无权限');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_PARAMS: Readonly<Record<string, readonly string[]>> = {
  [ORDERS]: [
    'page',
    'page_size',
    'platform',
    'platform_status',
    'rebate_status',
    'flag',
    'user_id',
    'q',
    'paid_from',
    'paid_to',
  ],
  [CLAIMS]: ['page', 'page_size', 'platform', 'evidence_level', 'status', 'user_id', 'q'],
  [WITHDRAWALS]: [
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
  ],
};
const CLAIM_STATUSES = [
  'submitted',
  'auto_matched',
  'manual_review',
  'approved',
  'rejected',
  'cancelled',
] as const;

export interface ServerData {
  users: UserRow[];
  orders: OrderRow[];
  claims: ClaimRow[];
  withdrawals: WithdrawalRow[];
}

export function data(): ServerData {
  return {
    users: users(),
    orders: [...uidOrders(), ...parentOrders()],
    claims: [...uidClaims(), ...parentClaims()],
    withdrawals: [...uidWithdrawals(), ...parentWithdrawals()],
  };
}

/**
 * In-process fake /admin/v1 for the account `snapshot`: every call goes through the real data
 * provider. Paging and permission answers follow the contract, never a page helper.
 */
export function createServer(snapshot: PermissionSnapshot = SUPER, initial: ServerData = data()) {
  const state = structuredClone(initial);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let pending = 0;
  const has = (point: string): boolean => snapshot.isSuper || snapshot.permissions.includes(point);

  // Without `page` the contract's default (page 1) applies; without `page_size`, 20.
  function page<T>(query: Record<string, string>, rows: readonly T[], extra: object = {}) {
    const number = Number(query['page'] ?? 1);
    const size = Number(query['page_size'] ?? 20);
    return ok({
      items: rows.slice((number - 1) * size, number * size),
      page: number,
      page_size: size,
      total: rows.length,
      ...extra,
    });
  }

  function listProblem(path: string, query: Record<string, string>): Response | undefined {
    const number = Number(query['page'] ?? 1);
    const size = Number(query['page_size'] ?? 20);
    if (!Number.isInteger(number) || number < 1) return failure(20001, { fields: ['page'] });
    if (!Number.isInteger(size) || size < 1 || size > 200)
      return failure(20001, { fields: ['page_size'] });
    const unknown = Object.keys(query).filter((name) => !LIST_PARAMS[path]!.includes(name));
    if (unknown.length > 0) return failure(20001, { fields: unknown });
    const user = query['user_id'];
    if (user !== undefined && !UUID.test(user)) return failure(20001, { fields: ['user_id'] });
    return undefined;
  }

  function normal(request: RequestLog): Response {
    const { method, path, query } = request;
    if (method !== 'GET') return failure(20001, { fields: ['unexpected_write'] });
    if (path === USERS) {
      if (!has('user.list')) return denied();
      const listed = { page: query['page'] ?? '1', page_size: query['page_size'] ?? '20' };
      return page(listed, state.users);
    }
    if (path === LOOKUP) {
      if (!has('user.lookup')) return denied();
      const found = state.users.find((row) => row.user_id === query['uid']);
      return found ? ok(userDetail(found)) : failure(20001, { fields: ['uid'] });
    }
    if (path.startsWith(`${USERS}/`)) {
      if (!has('user.list') && !has('user.lookup')) return denied();
      const found = state.users.find((row) => path === `${USERS}/${row.user_id}`);
      return found ? ok(userDetail(found)) : failure(20001, { fields: ['user_id'] });
    }
    if (path === ORDERS) {
      const withUser = query['user_id'] !== undefined;
      if (!has('order.view') && !(has('user.lookup') && withUser)) return denied();
      const problem = listProblem(path, query);
      if (problem !== undefined) return problem;
      return page(
        query,
        state.orders.filter((row) => !withUser || row.user?.user_id === query['user_id']),
      );
    }
    if (path === CLAIMS) {
      const withUser = query['user_id'] !== undefined;
      if (!has('order.claim') && !(has('user.lookup') && withUser)) return denied();
      const problem = listProblem(path, query);
      if (problem !== undefined) return problem;
      const rows = state.claims.filter((row) => !withUser || row.user.user_id === query['user_id']);
      const counts = Object.fromEntries(
        CLAIM_STATUSES.map((status) => [
          status,
          rows.filter((row) => row.status === status).length,
        ]),
      );
      return page(query, rows, { counts });
    }
    if (path === WITHDRAWALS) {
      if (!has('withdraw.review') && !has('fund.view')) return denied();
      const problem = listProblem(path, query);
      if (problem !== undefined) return problem;
      const withUser = query['user_id'] !== undefined;
      return page(
        query,
        state.withdrawals.filter((row) => !withUser || row.user.user_id === query['user_id']),
      );
    }
    // Detail reads of other pages (an order or a withdrawal opened from a row) are logged and
    // answered as unknown; the cases only look at which address was read.
    return failure(20001, { fields: ['path'] });
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request: RequestLog = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    log.push(request);
    pending += 1;
    try {
      const index = overrides.findIndex(
        (entry) => entry.method === request.method && entry.path === request.path,
      );
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
    } finally {
      pending -= 1;
    }
  };

  return {
    state,
    log,
    fetch,
    get pending() {
      return pending;
    },
    requests(method: string, path?: string) {
      return log.filter(
        (request) => request.method === method && (path === undefined || request.path === path),
      );
    },
    /** The next request to `path` gets `reply` instead of the normal answer. */
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
    /** The next request to `path` waits until the returned function is called. */
    hold(method: string, path: string) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        reply: async (request) => {
          await gate.promise;
          return normal(request);
        },
      });
      return gate.resolve;
    },
  };
}
export type Server = ReturnType<typeof createServer>;
