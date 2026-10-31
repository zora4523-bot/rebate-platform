import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.admin.default.json' with { type: 'json' };
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for the writes of CT-24zd (contracts/openapi.yaml, tag
// admin-settle-bills, implemented by B2-09f): confirmAdminSettleBill POST
// /admin/v1/settle-bills/{bill_id}/confirm, createAdminSettleSupplementBatches POST
// /admin/v1/settle-bills/{bill_id}/supplement-batches, cancelAdminSettleBatchSchedule /
// rejectAdminSettleBatch / resumeAdminSettleBatch POST /admin/v1/settle-batches/{batch_id}/…, on
// top of the three reads of CT-24z. Every write needs settle.bill and a totp step-up
// (X-Step-Up-Token from POST /admin/v1/auth/step-up); the fake server checks in the order the
// descriptions give. Ids are obvious fake UUIDs whose first 8 characters differ; months, amounts
// and admins are samples. Chinese names are read from the console dictionary when the test runs.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const MENU_ID = 'settle-bills';
export const LIST = '/admin/v1/settle-bills';
export const VERIFY = '/admin/v1/auth/step-up';
/** The six-digit code the fake server accepts. */
export const OTP = '123456';
/** Readable step-up grants: the fake server hands out `totp-pass-1`, `totp-pass-2`, … */
export const PASS_PREFIX = 'totp-pass-';

export const billPath = (billId: string): string => `${LIST}/${billId}`;
export const itemsPath = (batchId: string): string => `/admin/v1/settle-batches/${batchId}/items`;
export const confirmPath = (billId: string): string => `${LIST}/${billId}/confirm`;
export const supplementPath = (billId: string): string => `${LIST}/${billId}/supplement-batches`;
export type BatchAction = 'cancel-schedule' | 'reject' | 'resume';
export const batchPath = (batchId: string, act: BatchAction): string =>
  `/admin/v1/settle-batches/${batchId}/${act}`;

export type Bill = Schema<'AdminSettleBillDetail'>;
export type BillRow = Schema<'AdminSettleBill'>;
export type Batch = Schema<'AdminSettleBatch'>;
export type BatchItem = Schema<'AdminSettleBatchItem'>;

// ---- console dictionary (BR-TEXT-25 admin_dict) --------------------------------------------

export const DICT_FIELD = {
  batchStatus: /^admin_dict\.settle_batch(?:es)?(?:\.status|_status)\.([^.]+)$/,
  settleMode: /^admin_dict\.(?:settle_batch(?:es)?\.)?settle_mode\.([^.]+)$/,
  batchKind: /^admin_dict\.settle_batch(?:es)?(?:\.kind|_kind)\.([^.]+)$/,
} as const;
export type DictField = keyof typeof DICT_FIELD;

function dictionaryTexts(): Readonly<Record<string, string>> {
  return (dictionary as { texts?: Record<string, string> }).texts ?? {};
}
/** The dictionary's names for `code` of `field`; empty when it has no row (the code shows). */
export function dictNames(field: DictField, code: string): string[] {
  return Object.entries(dictionaryTexts()).flatMap(([name, value]) =>
    DICT_FIELD[field].exec(name)?.[1] === code ? [value] : [],
  );
}
function escapeText(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** One of the dictionary names of `code`, or the code as a whole word when there is no row. */
export function namePattern(field: DictField, code: string): RegExp {
  const names = dictNames(field, code);
  return new RegExp(
    names.length > 0
      ? `(?:${names.map(escapeText).join('|')})`
      : `(?<![A-Za-z0-9_])${escapeText(code)}(?![A-Za-z0-9_])`,
  );
}

// ---- samples -------------------------------------------------------------------------------

export const BILL = {
  /** generating: no batch yet. */
  generating: '2026-09',
  /** issued: two DRAFT main batches (taobao row_version 0, jd row_version 3). */
  issued: '2026-08',
  /** settling: taobao PARTIAL (row_version 4), jd CONFIRMED SCHEDULED not started (row_version 1). */
  settling: '2026-07',
  /** settled: DONE main and DONE supplement, taobao only; no DRAFT. */
  settled: '2026-06',
  /**
   * rounds: a DRAFT main batch outside the latest round (schedule cancelled after a supplement
   * launch, in_current_round false), a DONE jd main batch, a DRAFT supplement batch of the latest
   * round and a CANCELLED one.
   */
  rounds: '2026-05',
} as const;

export const BATCH = {
  issuedTaobao: 'b8000001-0000-4000-8000-000000000001',
  issuedJd: 'b8000002-0000-4000-8000-000000000002',
  partial: 'b7000001-0000-4000-8000-000000000001',
  scheduled: 'b7000002-0000-4000-8000-000000000002',
  doneMain: 'b6000001-0000-4000-8000-000000000001',
  doneSupplement: 'b6000002-0000-4000-8000-000000000002',
  staleDraft: 'b5000001-0000-4000-8000-000000000001',
  doneJd: 'b5000002-0000-4000-8000-000000000002',
  freshDraft: 'b5000003-0000-4000-8000-000000000003',
  rejected: 'b5000004-0000-4000-8000-000000000004',
  /** The batch a supplement launch on the settled bill generates. */
  created: 'b6000003-0000-4000-8000-000000000003',
} as const;

/** The admins who confirmed batches, and the one the fake server records for the caller. */
export const ADMIN = {
  first: 'ad000001-0000-4000-8000-0000000000a1',
  second: 'ad000002-0000-4000-8000-0000000000a2',
  caller: 'ad000003-0000-4000-8000-0000000000a3',
} as const;

type BatchFields = Pick<
  Batch,
  'batch_id' | 'platform' | 'kind' | 'status' | 'order_count' | 'created_at'
> &
  Partial<Batch>;

export function batch(fields: BatchFields): Batch {
  return {
    settle_mode: 'IMMEDIATE',
    scheduled_at: null,
    confirmed_by: null,
    confirmed_at: null,
    cancelled_reason: null,
    started_at: null,
    finished_at: null,
    paused_by_switch_at: null,
    row_version: 0,
    in_current_round: true,
    item_counts: {
      order: { credited: 0, skipped: 0, pending: fields.order_count },
      beneficiary: { credited: 0, skipped: 0, deferred: 0, pending: 0 },
    },
    ...fields,
  };
}

/** The five samples, bill_id descending. */
export function bills(): Bill[] {
  return [
    {
      bill_id: BILL.generating,
      status: 'generating',
      generation_started_at: '2026-10-24T02:00:00+08:00',
      generated_at: null,
      platform_order_counts: null,
      platform_settle_commission_totals: null,
      beneficiary_total_fen: null,
      platform_retained_fen: null,
      error_count: null,
      held_count: null,
      batch_count: 0,
      draft_batch_count: 0,
      created_at: '2026-10-24T02:00:00+08:00',
      batches: [],
    },
    {
      bill_id: BILL.issued,
      status: 'issued',
      generation_started_at: '2026-09-24T02:00:00+08:00',
      generated_at: '2026-09-24T02:10:05+08:00',
      platform_order_counts: { taobao: 1200, jd: 300 },
      platform_settle_commission_totals: { taobao: 864012, jd: -151005 },
      beneficiary_total_fen: 712034,
      platform_retained_fen: 302983,
      error_count: 4,
      held_count: 2,
      batch_count: 2,
      draft_batch_count: 2,
      created_at: '2026-09-24T02:00:00+08:00',
      batches: [
        batch({
          batch_id: BATCH.issuedTaobao,
          platform: 'taobao',
          kind: 'main',
          status: 'DRAFT',
          order_count: 1196,
          created_at: '2026-09-24T02:10:00+08:00',
          row_version: 0,
        }),
        batch({
          batch_id: BATCH.issuedJd,
          platform: 'jd',
          kind: 'main',
          status: 'DRAFT',
          order_count: 298,
          created_at: '2026-09-24T02:10:01+08:00',
          row_version: 3,
        }),
      ],
    },
    {
      bill_id: BILL.settling,
      status: 'settling',
      generation_started_at: '2026-08-24T02:00:00+08:00',
      generated_at: '2026-08-24T02:11:00+08:00',
      platform_order_counts: { taobao: 980, jd: 120 },
      platform_settle_commission_totals: { taobao: 702550, jd: 88001 },
      beneficiary_total_fen: 553386,
      platform_retained_fen: 237165,
      error_count: 0,
      held_count: 1,
      batch_count: 2,
      draft_batch_count: 0,
      created_at: '2026-08-24T02:00:00+08:00',
      batches: [
        batch({
          batch_id: BATCH.partial,
          platform: 'taobao',
          kind: 'main',
          status: 'PARTIAL',
          confirmed_by: ADMIN.first,
          confirmed_at: '2026-08-26T15:20:00+08:00',
          started_at: '2026-08-26T15:21:00+08:00',
          paused_by_switch_at: '2026-08-26T15:40:00+08:00',
          order_count: 975,
          created_at: '2026-08-24T02:10:30+08:00',
          row_version: 4,
          item_counts: {
            order: { credited: 600, skipped: 2, pending: 373 },
            beneficiary: { credited: 5, skipped: 0, deferred: 1, pending: 2 },
          },
        }),
        batch({
          batch_id: BATCH.scheduled,
          platform: 'jd',
          kind: 'main',
          status: 'CONFIRMED',
          settle_mode: 'SCHEDULED',
          scheduled_at: '2099-08-31T10:00:00+08:00',
          confirmed_by: ADMIN.second,
          confirmed_at: '2026-08-27T09:30:00+08:00',
          order_count: 118,
          created_at: '2026-08-24T02:10:40+08:00',
          row_version: 1,
        }),
      ],
    },
    {
      bill_id: BILL.settled,
      status: 'settled',
      generation_started_at: '2026-07-24T02:00:00+08:00',
      generated_at: '2026-07-24T02:09:00+08:00',
      platform_order_counts: { taobao: 640 },
      platform_settle_commission_totals: { taobao: 450000 },
      beneficiary_total_fen: 315000,
      platform_retained_fen: 135000,
      error_count: 1,
      held_count: 0,
      batch_count: 2,
      draft_batch_count: 0,
      created_at: '2026-07-24T02:00:00+08:00',
      batches: [
        batch({
          batch_id: BATCH.doneMain,
          platform: 'taobao',
          kind: 'main',
          status: 'DONE',
          confirmed_by: ADMIN.first,
          confirmed_at: '2026-07-25T10:00:00+08:00',
          started_at: '2026-07-25T10:00:05+08:00',
          finished_at: '2026-07-25T10:20:00+08:00',
          order_count: 636,
          created_at: '2026-07-24T02:08:00+08:00',
          in_current_round: false,
          row_version: 3,
        }),
        batch({
          batch_id: BATCH.doneSupplement,
          platform: 'taobao',
          kind: 'supplement',
          status: 'DONE',
          confirmed_by: ADMIN.second,
          confirmed_at: '2026-08-02T11:00:00+08:00',
          started_at: '2026-08-02T11:00:03+08:00',
          finished_at: '2026-08-02T11:01:00+08:00',
          order_count: 4,
          created_at: '2026-08-01T09:00:00+08:00',
          row_version: 3,
        }),
      ],
    },
    {
      bill_id: BILL.rounds,
      status: 'issued',
      generation_started_at: '2026-06-24T02:00:00+08:00',
      generated_at: '2026-06-24T02:09:00+08:00',
      platform_order_counts: { taobao: 300, jd: 80 },
      platform_settle_commission_totals: { taobao: 210000, jd: 56000 },
      beneficiary_total_fen: 186200,
      platform_retained_fen: 79800,
      error_count: 0,
      held_count: 0,
      batch_count: 4,
      draft_batch_count: 2,
      created_at: '2026-06-24T02:00:00+08:00',
      batches: [
        batch({
          batch_id: BATCH.staleDraft,
          platform: 'taobao',
          kind: 'main',
          status: 'DRAFT',
          order_count: 296,
          created_at: '2026-06-24T02:08:00+08:00',
          in_current_round: false,
          row_version: 2,
        }),
        batch({
          batch_id: BATCH.doneJd,
          platform: 'jd',
          kind: 'main',
          status: 'DONE',
          confirmed_by: ADMIN.first,
          confirmed_at: '2026-06-25T10:00:00+08:00',
          started_at: '2026-06-25T10:00:05+08:00',
          finished_at: '2026-06-25T10:05:00+08:00',
          order_count: 80,
          created_at: '2026-06-24T02:08:30+08:00',
          in_current_round: false,
          row_version: 3,
        }),
        batch({
          batch_id: BATCH.freshDraft,
          platform: 'taobao',
          kind: 'supplement',
          status: 'DRAFT',
          order_count: 3,
          created_at: '2026-07-02T09:00:00+08:00',
          row_version: 0,
        }),
        batch({
          batch_id: BATCH.rejected,
          platform: 'taobao',
          kind: 'supplement',
          status: 'CANCELLED',
          cancelled_reason: '核对后本批不入账',
          order_count: 1,
          created_at: '2026-07-02T09:00:00+08:00',
          row_version: 1,
        }),
      ],
    },
  ];
}

/** The three items of the PARTIAL batch (for 【明细】). */
export function partialItems(): BatchItem[] {
  const base = {
    user_id: null,
    role: null,
    beneficiary_credit_id: null,
    amount_fen: null,
    skip_reason: null,
    created_at: '2026-08-24T02:10:30+08:00',
  } as const;
  return [
    {
      ...base,
      id: 'e7000001-0000-4000-8000-000000000001',
      item_type: 'order',
      order_id: 'a7000001-0000-4000-8000-000000000001',
      settle_seq: 1,
      b_settle_fen: 72012,
      result: 'credited',
    },
    {
      ...base,
      id: 'e7000002-0000-4000-8000-000000000002',
      item_type: 'order',
      order_id: 'a7000002-0000-4000-8000-000000000002',
      settle_seq: 2,
      b_settle_fen: -1234,
      result: null,
    },
  ];
}

// ---- permissions ---------------------------------------------------------------------------

export type Grants = readonly KnownPermission[];
export const SETTLE_GRANTS: Grants = ['settle.bill'];
export const VIEW_GRANTS: Grants = ['fund.view'];
export const UPLOAD_GRANTS: Grants = ['settle.statement_upload'];
export const ADJUST_GRANTS: Grants = ['fund.settle_adjust'];

/** Permission snapshot as /admin/v1/me gives it: settle.bill carries the totp tier. */
export function snapshot(permissions: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of permissions)
    stepUp[point] = { tier: point === 'settle.bill' ? 'totp' : null, operations: {} };
  return { isSuper: false, permissions, stepUp };
}
/** A super admin: every point, no step-up annotation in the snapshot. */
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

// ---- envelopes -----------------------------------------------------------------------------

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
// HTTP statuses as in contracts/error-codes.yaml.
const STATUS: Record<number, number> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20002: 400,
  20901: 409,
  20902: 409,
  40901: 409,
  50001: 500,
};
const MESSAGE: Record<number, string> = {
  10001: '未登录',
  10003: '这项操作需要二次验证，请输入动态码',
  10403: '无权限',
  20001: '参数错误',
  20002: '验证码错误',
  20901: '请求内容有变化，请重新提交',
  20902: '状态已变化，请刷新后重试',
  50001: '服务暂时不可用',
};
/** An error envelope; `data` is left out when undefined. */
export function failure(code: number, data?: unknown): Response {
  const envelope: Record<string, unknown> = {
    code,
    msg: MESSAGE[code] ?? '操作失败',
    trace_id: TRACE_ID,
  };
  if (data !== undefined) envelope['data'] = data;
  return Response.json(envelope, { status: STATUS[code] ?? 400 });
}
export function rejected(fields: readonly string[], reason?: string): Response {
  return failure(20001, reason === undefined ? { fields } : { fields, reason });
}
export function conflict(): Response {
  return failure(20902, { resource: 'settle_batch' });
}
export function stepUpRequired(): Response {
  return failure(10003, { tier: 'totp' });
}

// ---- fake server ---------------------------------------------------------------------------

export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;
export type When = (request: RequestLog) => boolean;

/** The five writes of CT-24zd. */
export type WriteOp = 'confirm' | 'supplement' | 'cancel-schedule' | 'reject' | 'resume';

export interface ServerOptions {
  /** Permission points the server checks (10403 otherwise). */
  readonly permissions?: Grants;
  /** Writes this test may trigger; any other request than the three reads and step-up is a stray. */
  readonly writes?: readonly WriteOp[];
  /** What a supplement launch finds: one new batch (default), nothing, or a duplicate claim. */
  readonly supplement?: 'one' | 'none' | 'duplicate';
}

const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const DETAIL = /^\/admin\/v1\/settle-bills\/([^/]+)$/;
const ITEMS = /^\/admin\/v1\/settle-batches\/([^/]+)\/items$/;
const CONFIRM = /^\/admin\/v1\/settle-bills\/([^/]+)\/confirm$/;
const SUPPLEMENT = /^\/admin\/v1\/settle-bills\/([^/]+)\/supplement-batches$/;
const BATCH_WRITE = /^\/admin\/v1\/settle-batches\/([^/]+)\/(cancel-schedule|reject|resume)$/;
const PLATFORMS: readonly string[] = ['taobao', 'jd', 'pdd', 'vip', 'meituan', 'eleme'];
const BEIJING_MS = 8 * 3600 * 1000;

/** Which of the five writes a request is (POST only). */
export function writeOf(request: Pick<RequestLog, 'method' | 'path'>): WriteOp | undefined {
  if (request.method !== 'POST') return undefined;
  if (CONFIRM.test(request.path)) return 'confirm';
  if (SUPPLEMENT.test(request.path)) return 'supplement';
  const match = BATCH_WRITE.exec(request.path);
  return match === null ? undefined : (match[2] as WriteOp);
}
/** One of the three reads of CT-24z. */
export function isRead(request: Pick<RequestLog, 'method' | 'path'>): boolean {
  return (
    request.method === 'GET' &&
    (request.path === LIST || DETAIL.test(request.path) || ITEMS.test(request.path))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function onlyKeys(body: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(body).every((name) => keys.includes(name));
}
/** A schedule time the server takes: a date-time later than now, outside 23:00–01:00 Beijing. */
function scheduleAllowed(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return false;
  const at = Date.parse(value);
  if (Number.isNaN(at) || at <= Date.now()) return false;
  const hour = new Date(at + BEIJING_MS).getUTCHours();
  return hour !== 23 && hour !== 0;
}

/** Fake /admin/v1 server with the CT-24z reads, the step-up and the CT-24zd writes. */
export function createServer(initial: Bill[] = bills(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const items = new Map<string, BatchItem[]>([[BATCH.partial, partialItems()]]);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; when: When | undefined; reply: Reply }[] = [];
  const permissions = options.permissions ?? SETTLE_GRANTS;
  const allowed = new Set<WriteOp>(options.writes ?? []);
  const issued: string[] = [];
  const launches = new Map<string, { body: string; data: unknown }>();
  let inFlight = 0;

  const canRead = (): boolean =>
    permissions.includes('settle.bill') || permissions.includes('fund.view');
  const canWrite = (): boolean => permissions.includes('settle.bill');
  const findBill = (billId: string): Bill | undefined =>
    MONTH.test(billId) ? state.find((bill) => bill.bill_id === billId) : undefined;
  const owner = (batchId: string): { bill: Bill; batch: Batch } | undefined => {
    for (const bill of state) {
      const found = bill.batches.find((one) => one.batch_id === batchId);
      if (found !== undefined) return { bill, batch: found };
    }
    return undefined;
  };
  const recount = (bill: Bill): void => {
    bill.batch_count = bill.batches.length;
    bill.draft_batch_count = bill.batches.filter((one) => one.status === 'DRAFT').length;
  };
  const stepUpValid = (request: RequestLog): boolean => {
    const presented = request.headers.get('X-Step-Up-Token');
    return presented !== null && issued.includes(presented);
  };

  function list(): Response {
    if (!canRead()) return failure(10403, { reason: 'admin_permission_denied' });
    const rows: BillRow[] = state
      .slice()
      .sort((a, b) => (a.bill_id < b.bill_id ? 1 : -1))
      .map((bill) => ({
        bill_id: bill.bill_id,
        status: bill.status,
        generation_started_at: bill.generation_started_at,
        generated_at: bill.generated_at,
        platform_order_counts: bill.platform_order_counts,
        platform_settle_commission_totals: bill.platform_settle_commission_totals,
        beneficiary_total_fen: bill.beneficiary_total_fen,
        platform_retained_fen: bill.platform_retained_fen,
        error_count: bill.error_count,
        held_count: bill.held_count,
        batch_count: bill.batch_count,
        draft_batch_count: bill.draft_batch_count,
        created_at: bill.created_at,
      }));
    return ok({ items: rows, page: 1, page_size: 20, total: rows.length });
  }

  function verify(request: RequestLog): Response {
    const body = request.body;
    if (!isRecord(body) || body['tier'] !== 'totp' || body['code'] !== OTP) return failure(20002);
    const pass = `${PASS_PREFIX}${issued.length + 1}`;
    issued.push(pass);
    return ok({ step_up_token: pass, tier: 'totp', expire_at: '2099-01-01T00:00:00+08:00' });
  }

  function confirm(billId: string, body: unknown): Response {
    if (!isRecord(body) || !onlyKeys(body, ['expected_batches', 'settle_mode', 'scheduled_at']))
      return rejected(['expected_batches']);
    const expected = body['expected_batches'];
    if (
      !Array.isArray(expected) ||
      expected.length > 1000 ||
      !expected.every(
        (entry) =>
          isRecord(entry) &&
          onlyKeys(entry, ['batch_id', 'expected_row_version']) &&
          typeof entry['batch_id'] === 'string' &&
          isVersion(entry['expected_row_version']),
      )
    )
      return rejected(['expected_batches']);
    const requested = body['settle_mode'];
    const when = body['scheduled_at'];
    let mode: Schema<'AdminSettleMode'>;
    if (requested === undefined || requested === 'IMMEDIATE') mode = 'IMMEDIATE';
    else if (requested === 'SCHEDULED') mode = 'SCHEDULED';
    else return rejected(['settle_mode']);
    if (mode === 'IMMEDIATE' && when !== undefined) return rejected(['scheduled_at']);
    if (mode === 'SCHEDULED' && !scheduleAllowed(when)) return rejected(['scheduled_at']);
    const bill = findBill(billId);
    if (bill === undefined) return rejected(['bill_id']);
    if (bill.status === 'generating') return rejected(['bill_id'], 'bill_not_ready');
    const drafts = bill.batches.filter((one) => one.status === 'DRAFT');
    const entries = expected as { batch_id: string; expected_row_version: number }[];
    const ids = new Set(entries.map((entry) => entry.batch_id));
    const exact =
      drafts.length > 0 &&
      ids.size === entries.length &&
      entries.length === drafts.length &&
      drafts.every((one) =>
        entries.some(
          (entry) =>
            entry.batch_id === one.batch_id && entry.expected_row_version === one.row_version,
        ),
      );
    if (!exact) return conflict();
    const now = new Date().toISOString();
    for (const one of drafts) {
      one.status = 'CONFIRMED';
      one.settle_mode = mode;
      one.scheduled_at = mode === 'SCHEDULED' ? String(when) : null;
      one.confirmed_by = ADMIN.caller;
      one.confirmed_at = now;
      one.row_version += 1;
    }
    recount(bill);
    return ok(bill);
  }

  function batchWrite(batchId: string, act: BatchAction, body: unknown): Response {
    const keys = act === 'reject' ? ['expected_row_version', 'reason'] : ['expected_row_version'];
    if (!isRecord(body) || !onlyKeys(body, keys) || !isVersion(body['expected_row_version']))
      return rejected(['expected_row_version']);
    let reason = '';
    if (act === 'reject') {
      const given = body['reason'];
      reason = typeof given === 'string' ? given.trim() : '';
      if (reason.length < 1 || reason.length > 200) return rejected(['reason']);
    }
    const found = owner(batchId);
    if (found === undefined) return rejected(['batch_id']);
    const { bill, batch: one } = found;
    if (one.row_version !== body['expected_row_version']) return conflict();
    if (act === 'cancel-schedule') {
      if (one.status !== 'CONFIRMED' || one.settle_mode !== 'SCHEDULED' || one.started_at !== null)
        return conflict();
      one.status = 'DRAFT';
      one.settle_mode = 'IMMEDIATE';
      one.scheduled_at = null;
      one.confirmed_by = null;
      one.confirmed_at = null;
    } else if (act === 'reject') {
      if (one.status !== 'DRAFT') return conflict();
      one.status = 'CANCELLED';
      one.cancelled_reason = reason;
    } else {
      if (one.status !== 'PARTIAL') return conflict();
      one.status = 'EXECUTING';
    }
    one.row_version += 1;
    recount(bill);
    return ok(bill);
  }

  function supplement(billId: string, request: RequestLog): Response {
    const body = request.body;
    if (!isRecord(body) || !onlyKeys(body, ['platform'])) return rejected(['platform']);
    const platform = body['platform'];
    if (typeof platform !== 'string' || !PLATFORMS.includes(platform))
      return rejected(['platform']);
    const idempotency = request.headers.get('Idempotency-Key');
    if (idempotency === null || idempotency === '') return rejected(['Idempotency-Key']);
    const bill = findBill(billId);
    if (bill === undefined) return rejected(['bill_id']);
    const text = JSON.stringify({ billId, platform });
    const earlier = launches.get(idempotency);
    if (earlier !== undefined) return earlier.body === text ? ok(earlier.data) : failure(20901);
    if (bill.status === 'generating' || !Object.hasOwn(bill.platform_order_counts ?? {}, platform))
      return rejected(['bill_id'], 'bill_not_ready');
    if (bill.batches.some((one) => one.status === 'DRAFT'))
      return rejected(['bill_id'], 'pending_draft');
    const mode = options.supplement ?? 'one';
    const ids: string[] = [];
    if (mode === 'one') {
      for (const one of bill.batches) one.in_current_round = false;
      bill.batches.push(
        batch({
          batch_id: BATCH.created,
          platform: platform as Batch['platform'],
          kind: 'supplement',
          status: 'DRAFT',
          order_count: 4,
          created_at: new Date().toISOString(),
        }),
      );
      ids.push(BATCH.created);
      recount(bill);
    }
    const data = {
      bill_id: billId,
      platform,
      outcome: mode === 'duplicate' ? 'duplicate' : 'generated',
      batch_ids: ids,
    };
    launches.set(idempotency, { body: text, data });
    return ok(data);
  }

  function write(op: WriteOp, request: RequestLog): Response {
    if (!canWrite()) return failure(10403, { reason: 'admin_permission_denied' });
    if (!stepUpValid(request)) return stepUpRequired();
    if (op === 'confirm')
      return confirm(decodeURIComponent(CONFIRM.exec(request.path)![1]!), request.body);
    if (op === 'supplement')
      return supplement(decodeURIComponent(SUPPLEMENT.exec(request.path)![1]!), request);
    const match = BATCH_WRITE.exec(request.path)!;
    return batchWrite(decodeURIComponent(match[1]!), match[2] as BatchAction, request.body);
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token')
      return failure(10001);
    if (method === 'GET' && path === LIST) return list();
    const one = DETAIL.exec(path);
    if (method === 'GET' && one !== null) {
      if (!canRead()) return failure(10403, { reason: 'admin_permission_denied' });
      const found = findBill(decodeURIComponent(one[1]!));
      return found === undefined ? rejected(['bill_id']) : ok(found);
    }
    const owned = ITEMS.exec(path);
    if (method === 'GET' && owned !== null) {
      if (!canRead()) return failure(10403, { reason: 'admin_permission_denied' });
      const batchId = decodeURIComponent(owned[1]!);
      if (owner(batchId) === undefined) return rejected(['batch_id']);
      const rows = items.get(batchId) ?? [];
      return ok({ items: rows, page: 1, page_size: 20, total: rows.length });
    }
    if (method === 'POST' && path === VERIFY) return verify(request);
    const op = writeOf(request);
    if (op !== undefined) return write(op, request);
    return rejected(['path']);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const request: RequestLog = {
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : undefined,
    };
    log.push(request);
    inFlight += 1;
    try {
      const index = overrides.findIndex(
        (entry) =>
          entry.method === request.method &&
          entry.path === request.path &&
          (entry.when === undefined || entry.when(request)),
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
    /** The step-up grants handed out so far, in order. */
    issued,
    get pending() {
      return inFlight;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    billReads(billId: string) {
      return log.filter((r) => r.method === 'GET' && r.path === billPath(billId));
    },
    itemReads(batchId: string) {
      return log.filter((r) => r.method === 'GET' && r.path === itemsPath(batchId));
    },
    /** POST /admin/v1/auth/step-up. */
    verifies() {
      return log.filter((r) => r.method === 'POST' && r.path === VERIFY);
    },
    /** The write requests (of `op`, when given). */
    writes(op?: WriteOp) {
      return log.filter((r) => {
        const kind = writeOf(r);
        return kind !== undefined && (op === undefined || kind === op);
      });
    },
    /** Requests that are not a read, a step-up or one of the writes this test allows. */
    strays() {
      return log
        .filter((r) => {
          if (isRead(r) || (r.method === 'POST' && r.path === VERIFY)) return false;
          const kind = writeOf(r);
          return kind === undefined || !allowed.has(kind);
        })
        .map((r) => `${r.method} ${r.path}`);
    },
    /** Answers the next request of `method` `path` (matching `when`) with `reply`. */
    once(method: string, path: string, reply: Reply, when?: When) {
      overrides.push({ method, path, when, reply });
    },
    /** Answers the next request of `method` `path` normally, after running `before`. */
    after(method: string, path: string, before: () => void) {
      overrides.push({
        method,
        path,
        when: undefined,
        reply: (request) => {
          before();
          return normal(request);
        },
      });
    },
    /** Holds the next request of `method` `path` until the returned call. */
    hold(method: string, path: string) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        when: undefined,
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

/** The bill `billId` of the server's state. */
export function billOf(server: Server, billId: string): Bill {
  const found = server.state.find((bill) => bill.bill_id === billId);
  if (found === undefined) throw new Error(`fixture bill ${billId}`);
  return found;
}
/** The batch `batchId` of the server's state. */
export function batchOf(server: Server, batchId: string): Batch {
  for (const bill of server.state) {
    const found = bill.batches.find((one) => one.batch_id === batchId);
    if (found !== undefined) return found;
  }
  throw new Error(`fixture batch ${batchId}`);
}
