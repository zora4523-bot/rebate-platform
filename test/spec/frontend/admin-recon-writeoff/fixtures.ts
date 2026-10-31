import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for the 【核销】 of an R2 late success (CT-24za writeOffAdminReconDiff,
// POST /admin/v1/recon-diffs/{recon_diff_id}/write-off) next to the reads of CT-24v
// (listAdminReconDiffs, getAdminReconDiff). The fake server checks in the order the contract
// description gives: payout.execute → totp step-up → Idempotency-Key replay → body → id → status
// → the W11 guard → the withdrawal compare-and-set. Ids are obvious fake UUIDs; references,
// amounts and notes are samples. Chinese names are transcribed from the console dictionary
// (contracts/texts.admin.default.json, BR-TEXT-25) as an independent oracle.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const LIST = '/admin/v1/recon-diffs';
export const VERIFY = '/admin/v1/auth/step-up';
/** The bearer value the data provider sends (a readable sample). */
export const BEARER = 'example-admin-token';
/** The totp code the fake step-up accepts. */
export const TOTP_CODE = '123456';
/** The server's clock when it writes a difference off. */
export const NOW = '2026-10-31T10:00:00+08:00';

export const detailPath = (id: string): string => `${LIST}/${id}`;
export const writeOffPath = (id: string): string => `${LIST}/${id}/write-off`;
/** The n-th step-up value the fake server hands out (low entropy, readable). */
export const stepUpValue = (n: number): string => `stepup-totp-${n}`;

export type DiffDetail = Schema<'AdminReconDiffDetail'>;
export type Diff = Schema<'AdminReconDiff'>;
export type DiffStatus = Schema<'AdminReconDiffStatus'>;
export type WithdrawalStatus = Schema<'WithdrawalStatus'>;
export type WriteOffBody = Schema<'AdminReconDiffWriteOffRequest'>;

/** admin_dict.recon_diff_status.* */
export const STATUS_NAME: Readonly<Record<DiffStatus, string>> = {
  open: '待处理',
  processing: '处理中',
  adjusted: '已调账',
  written_off: '已核销',
  closed: '已关闭（不处理）',
};

/** The five data.reason values of the W11 guard (each 20001 with data.fields=[recon_diff_id]). */
export const GUARD_REASONS = [
  'not_payer_side_case',
  'writeoff_disabled',
  'withdrawal_not_returned',
  'transfer_attempts_mismatch',
  'amount_mismatch',
] as const;
export type GuardReason = (typeof GUARD_REASONS)[number];

export const ID = {
  /** R2 channel_mismatch, open, one withdrawal hold: a returned withdrawal the bill shows paid. */
  late: 'e2000001-0000-4000-8000-000000000001',
  /** R2 channel_mismatch, processing, two withdrawal holds. */
  busy: 'e2000002-0000-4000-8000-000000000002',
  /** R2 channel_mismatch, open, no withdrawal hold. */
  quiet: 'e2000003-0000-4000-8000-000000000003',
  /** R3 ledger_mismatch, open (not R2: no 【核销】). */
  ledger: 'e2000004-0000-4000-8000-000000000004',
  /** R1 union_mismatch, open (not R2: no 【核销】). */
  union: 'e2000005-0000-4000-8000-000000000005',
  /** R2 channel_mismatch, closed. */
  closed: 'e2000006-0000-4000-8000-000000000006',
  /** R2 channel_mismatch, adjusted. */
  adjusted: 'e2000007-0000-4000-8000-000000000007',
  /** R2 channel_mismatch, written_off. */
  written: 'e2000008-0000-4000-8000-000000000008',
} as const;
export const REF = {
  late: 'wd-late-0001',
  busy: 'wd-late-0002',
  quiet: 'wd-late-0003',
  ledger: 'acct-test-0004',
  union: 'taobao:5550005',
  closed: 'wd-done-0006',
  adjusted: 'wd-done-0007',
  written: 'wd-done-0008',
} as const;
/** The withdrawal of each R2 sample (the difference's ref). */
export const WITHDRAWAL: Readonly<Record<string, string>> = {
  [ID.late]: 'a2000001-0000-4000-8000-00000000a001',
  [ID.busy]: 'a2000002-0000-4000-8000-00000000a002',
  [ID.quiet]: 'a2000003-0000-4000-8000-00000000a003',
  [ID.closed]: 'a2000006-0000-4000-8000-00000000a006',
  [ID.adjusted]: 'a2000007-0000-4000-8000-00000000a007',
  [ID.written]: 'a2000008-0000-4000-8000-00000000a008',
};
/** The admin who handled the processing / finished samples. */
export const HANDLER = 'ad000001-0000-4000-8000-0000000000a1';
/** The signed-in admin (handler_id after a write-off). */
export const SELF = 'ad000002-0000-4000-8000-0000000000a2';
/** The bill line's time of the late success (paid_at of W11; never the write-off time). */
export const BILL_PAID_AT = '2026-10-20T15:02:11+08:00';

/** Unreleased withdrawal holds whose source is each sample. */
export const HOLDS: Readonly<Record<string, number>> = {
  [ID.late]: 1,
  [ID.busy]: 2,
  [ID.quiet]: 0,
};

function r2(
  id: string,
  ref: string,
  status: DiffStatus,
  created: string,
  patch: Partial<DiffDetail> = {},
): DiffDetail {
  const finished = status !== 'open' && status !== 'processing';
  return {
    recon_diff_id: id,
    source: 'R2',
    type: 'channel_mismatch',
    period: '2026-10-20',
    ref_type: 'withdrawal',
    ref_id: ref,
    expected_fen: 0,
    actual_fen: 10000,
    diff_fen: -10000,
    status,
    created_at: created,
    closed_at: finished ? '2026-10-22T10:00:00+08:00' : null,
    handler_id: status === 'open' ? null : HANDLER,
    updated_at: finished ? '2026-10-22T10:00:00+08:00' : created,
    resolution: status === 'open' ? null : { case: 'payer_side_returned' },
    ...patch,
  };
}

/** The eight samples, newest first (created_at descending, the list's order). */
export function diffs(): DiffDetail[] {
  return [
    r2(ID.late, REF.late, 'open', '2026-10-21T01:10:00+08:00', {
      resolution: { case: 'payer_side_returned', bill_date: '2026-10-20' },
    }),
    r2(ID.busy, REF.busy, 'processing', '2026-10-21T01:09:00+08:00', {
      expected_fen: 0,
      actual_fen: 25000,
      diff_fen: -25000,
      updated_at: '2026-10-21T09:00:00+08:00',
    }),
    r2(ID.quiet, REF.quiet, 'open', '2026-10-21T01:08:00+08:00', {
      actual_fen: 3000,
      diff_fen: -3000,
    }),
    {
      recon_diff_id: ID.ledger,
      source: 'R3',
      type: 'ledger_mismatch',
      period: '2026-10-20',
      ref_type: 'account',
      ref_id: REF.ledger,
      expected_fen: 12000,
      actual_fen: 11800,
      diff_fen: 200,
      status: 'open',
      created_at: '2026-10-21T01:05:00+08:00',
      closed_at: null,
      handler_id: null,
      updated_at: '2026-10-21T01:05:00+08:00',
      resolution: null,
    },
    {
      recon_diff_id: ID.union,
      source: 'R1',
      type: 'union_mismatch',
      period: '2026-09',
      ref_type: 'order',
      ref_id: REF.union,
      expected_fen: 1234,
      actual_fen: 1200,
      diff_fen: 34,
      status: 'open',
      created_at: '2026-10-20T10:00:00+08:00',
      closed_at: null,
      handler_id: null,
      updated_at: '2026-10-20T10:00:00+08:00',
      resolution: null,
    },
    r2(ID.closed, REF.closed, 'closed', '2026-10-19T01:10:00+08:00', {
      resolution: { reason: '通道已退回，无需处理' },
    }),
    r2(ID.adjusted, REF.adjusted, 'adjusted', '2026-10-18T01:10:00+08:00', {
      resolution: { adjustment_ref: 'adj-test-0007' },
    }),
    r2(ID.written, REF.written, 'written_off', '2026-10-17T01:10:00+08:00', {
      resolution: { w11_by_bill_line: true },
    }),
  ];
}

/** Permission points an account holds. */
export type Grants = readonly KnownPermission[];
/** fund.recon and payout.execute: reads, closes and writes off. */
export const WRITE_GRANTS: Grants = ['fund.recon', 'payout.execute'];
/** fund.view and payout.execute: reads and writes off (no close). */
export const VIEW_WRITE_GRANTS: Grants = ['fund.view', 'payout.execute'];
/** fund.recon only (the F1-08e sample account): no 【核销】. */
export const RECON_GRANTS: Grants = ['fund.recon'];

/** Permission snapshot: payout.execute needs the totp tier (BR-ID-34), the others none. */
export function snapshot(permissions: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of permissions)
    stepUp[point] = { tier: point === 'payout.execute' ? 'totp' : null, operations: {} };
  return { isSuper: false, permissions, stepUp };
}

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
// HTTP statuses as in contracts/error-codes.yaml.
const HTTP: Record<number, number> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20901: 409,
  20902: 409,
  40901: 409,
};
/** An error envelope; `data` is left out when undefined. */
export function failure(code: number, data?: unknown, msg = '参数错误'): Response {
  const envelope: Record<string, unknown> = { code, msg, trace_id: TRACE_ID };
  if (data !== undefined) envelope['data'] = data;
  return Response.json(envelope, { status: HTTP[code] ?? 400 });
}
export function rejected(fields: readonly string[]): Response {
  return failure(20001, { fields });
}
/** 20001 of the W11 guard with its reason. */
export function refused(reason: GuardReason): Response {
  return failure(20001, { fields: ['recon_diff_id'], reason });
}
export function stepUpRequired(): Response {
  return failure(10003, { tier: 'totp' }, '需要二次验证');
}
export function denied(): Response {
  return failure(10403, { reason: 'admin_permission_denied' }, '无权限');
}
export function diffConflict(): Response {
  return failure(20902, { resource: 'recon_diff' }, '状态已变化，请刷新后重试');
}
export function withdrawalConflict(): Response {
  return failure(20902, { resource: 'withdrawal' }, '状态已变化，请刷新后重试');
}
export function changedBody(): Response {
  return failure(20901, undefined, '请求内容有变化，请重新提交');
}
export function inProgress(): Response {
  return failure(40901, undefined, '请求处理中，请稍后');
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
  /** Unreleased withdrawal holds per difference. */
  readonly holds?: Readonly<Record<string, number>>;
  /** Differences whose W11 guard refuses, with the reason. */
  readonly refuse?: Readonly<Record<string, GuardReason>>;
}

const DETAIL = /^\/admin\/v1\/recon-diffs\/([^/]+)$/;
const WRITE_OFF = /^\/admin\/v1\/recon-diffs\/([^/]+)\/write-off$/;
/** Requests this page may send: the F1-08e reads, the totp step-up and the write-off. */
const ALLOWED: readonly { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/admin\/v1\/recon-diffs$/ },
  { method: 'GET', path: DETAIL },
  { method: 'POST', path: /^\/admin\/v1\/auth\/step-up$/ },
  { method: 'POST', path: WRITE_OFF },
];

function rowOf(item: DiffDetail): Diff {
  return {
    recon_diff_id: item.recon_diff_id,
    source: item.source,
    type: item.type,
    period: item.period,
    ref_type: item.ref_type,
    ref_id: item.ref_id,
    expected_fen: item.expected_fen,
    actual_fen: item.actual_fen,
    diff_fen: item.diff_fen,
    status: item.status,
    created_at: item.created_at,
    closed_at: item.closed_at,
  };
}
function newestFirst(a: DiffDetail, b: DiffDetail): number {
  const time = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (time !== 0) return time;
  return a.recon_diff_id < b.recon_diff_id ? 1 : a.recon_diff_id > b.recon_diff_id ? -1 : 0;
}

/** What the after-test check reads of a server. */
export interface Checked {
  unexpected(): RequestLog[];
}
/** Servers created by the current test (checked against the request whitelist after it). */
export const created: Checked[] = [];

/** Fake /admin/v1 server with the CT-24v reads, the totp step-up and the CT-24za write-off. */
export function createServer(initial: DiffDetail[] = diffs(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const holds = new Map<string, number>(Object.entries(options.holds ?? HOLDS));
  const refuse = new Map<string, GuardReason>(Object.entries(options.refuse ?? {}));
  const withdrawals = new Map<string, WithdrawalStatus>(
    Object.keys(WITHDRAWAL).map((id): [string, WithdrawalStatus] => [id, 'APPROVED']),
  );
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  /** First results of each Idempotency-Key: the request it answered and the data returned. */
  const results = new Map<string, { request: string; data: unknown }>();
  /** Step-up values handed out, in order. */
  const issued: string[] = [];
  const permissions = options.permissions ?? WRITE_GRANTS;
  let inFlight = 0;

  const has = (point: KnownPermission): boolean => permissions.includes(point);
  const canRead = (): boolean => has('fund.recon') || has('fund.view');
  const find = (id: string): DiffDetail | undefined =>
    state.find((item) => item.recon_diff_id === id);

  function list(query: Record<string, string>): Response {
    if (!canRead()) return denied();
    const { source, status, type, ref_id: ref, page, page_size: size } = query;
    const matching = state
      .filter(
        (item) =>
          (type === undefined || item.type === type) &&
          (source === undefined || item.source === source) &&
          (status === undefined || item.status === status) &&
          (ref === undefined || item.ref_id === ref),
      )
      .sort(newestFirst);
    const pageNo = page === undefined ? 1 : Number(page);
    const pageSize = size === undefined ? 20 : Number(size);
    const items = matching.slice((pageNo - 1) * pageSize, pageNo * pageSize).map(rowOf);
    return ok({ items, page: pageNo, page_size: pageSize, total: matching.length });
  }

  function detail(id: string): Response {
    if (!canRead()) return denied();
    const found = find(id);
    if (found === undefined) return rejected(['recon_diff_id']);
    return ok(found);
  }

  function verify(request: RequestLog): Response {
    const body = request.body as Partial<Schema<'AdminStepUpRequest'>> | undefined;
    if (body?.tier !== 'totp') return rejected(['tier']);
    if (body.code !== TOTP_CODE) return failure(20002, undefined, '验证码错误');
    issued.push(stepUpValue(issued.length + 1));
    return ok({ step_up_token: issued.at(-1), tier: 'totp', expire_at: '2099-01-01T00:00:00Z' });
  }

  function writeOff(id: string, request: RequestLog): Response {
    if (!has('payout.execute')) return denied();
    const presented = request.headers.get('X-Step-Up-Token');
    if (presented === null || !issued.includes(presented)) return stepUpRequired();
    const idempotency = request.headers.get('Idempotency-Key');
    if (idempotency === null || idempotency.trim() === '') return rejected(['Idempotency-Key']);
    // The step-up value is a header, not part of the body hash.
    const fingerprint = `${id} ${JSON.stringify(request.body ?? null)}`;
    const first = results.get(idempotency);
    if (first !== undefined) return first.request === fingerprint ? ok(first.data) : changedBody();
    const body =
      typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const unknown = Object.keys(body).filter(
      (name) => name !== 'expected_withdrawal_status' && name !== 'note',
    );
    if (unknown.length > 0) return rejected(unknown);
    if (body['expected_withdrawal_status'] !== 'APPROVED') {
      return rejected(['expected_withdrawal_status']);
    }
    const note = body['note'];
    if (
      note !== undefined &&
      (typeof note !== 'string' || note.trim() === '' || note.trim().length > 200)
    ) {
      return rejected(['note']);
    }
    const found = find(id);
    if (found === undefined) return rejected(['recon_diff_id']);
    if (found.status !== 'open' && found.status !== 'processing') return diffConflict();
    const reason = found.source === 'R2' ? refuse.get(id) : 'not_payer_side_case';
    if (reason !== undefined) return refused(reason);
    const withdrawalId = WITHDRAWAL[id];
    if (withdrawalId === undefined) return refused('not_payer_side_case');
    if (withdrawals.get(id) !== 'APPROVED') return withdrawalConflict();
    withdrawals.set(id, 'PAID_API');
    const released = holds.get(id) ?? 0;
    holds.set(id, 0);
    found.status = 'written_off';
    found.closed_at = NOW;
    found.updated_at = NOW;
    found.handler_id = SELF;
    found.resolution = {
      ...(found.resolution ?? {}),
      w11: { withdrawal_id: withdrawalId, paid_at: BILL_PAID_AT, operator: SELF },
      ...(typeof note === 'string' ? { note: note.trim() } : {}),
    };
    const data: Schema<'AdminReconDiffWriteOff'> = {
      recon_diff: structuredClone(found),
      withdrawal: {
        withdrawal_id: withdrawalId,
        status: 'PAID_API',
        paid_at: BILL_PAID_AT,
        channel_order_id: '20261020110070001502110012345678',
      },
      released_hold_count: released,
    };
    results.set(idempotency, { request: fingerprint, data });
    return ok(data);
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== `Bearer ${BEARER}`) {
      return failure(10001, undefined, '未登录');
    }
    if (method === 'GET' && path === LIST) return list(request.query);
    const one = DETAIL.exec(path);
    if (method === 'GET' && one !== null) return detail(decodeURIComponent(one[1]!));
    if (method === 'POST' && path === VERIFY) return verify(request);
    const writing = WRITE_OFF.exec(path);
    if (method === 'POST' && writing !== null) {
      return writeOff(decodeURIComponent(writing[1]!), request);
    }
    return rejected(['path']);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const request: RequestLog = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
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

  const server = {
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
    /** GET /admin/v1/recon-diffs (the list). */
    reads() {
      return log.filter((r) => r.method === 'GET' && r.path === LIST);
    },
    /** GET …/{id} of one difference. */
    detailReads(id: string) {
      return log.filter((r) => r.method === 'GET' && r.path === detailPath(id));
    },
    /** POST …/{id}/write-off (every id when none is given). */
    writeOffs(id?: string) {
      const wanted = (path: string): boolean =>
        id === undefined ? WRITE_OFF.test(path) : path === writeOffPath(id);
      return log.filter((r) => r.method === 'POST' && wanted(r.path));
    },
    /** POST /admin/v1/auth/step-up. */
    verifies() {
      return log.filter((r) => r.method === 'POST' && r.path === VERIFY);
    },
    /** Requests outside the whitelist of this page. */
    unexpected() {
      return log.filter(
        (r) => !ALLOWED.some((entry) => entry.method === r.method && entry.path.test(r.path)),
      );
    },
    /** Step-up values handed out so far. */
    issued(): readonly string[] {
      return issued;
    },
    item(id: string): DiffDetail {
      const found = find(id);
      if (found === undefined) throw new Error(`fixture ${id}`);
      return found;
    },
    holdsOf(id: string): number {
      return holds.get(id) ?? 0;
    },
    withdrawalOf(id: string): WithdrawalStatus | undefined {
      return withdrawals.get(id);
    },
    /** Another admin handled the difference meanwhile. */
    setStatus(id: string, status: DiffStatus) {
      const found = find(id);
      if (found === undefined) throw new Error(`fixture ${id}`);
      found.status = status;
      found.handler_id = HANDLER;
      found.updated_at = NOW;
      if (status !== 'open' && status !== 'processing') found.closed_at = NOW;
    },
    /** The withdrawal moved meanwhile (rejected, executed again or settled). */
    setWithdrawal(id: string, status: WithdrawalStatus) {
      withdrawals.set(id, status);
    },
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
  };
  created.push(server);
  return server;
}
export type Server = ReturnType<typeof createServer>;
