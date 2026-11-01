// F1-07je fixtures: an in-process fake of /admin/v1 for the users list's 【导出】【导出记录】
// (contracts/openapi.yaml adminListUsers, adminGetUser, adminCreateExport, adminListExports,
// adminStepUp). Every call still passes through the real data provider. No page module is
// imported here; the ids are visibly fake.
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';

export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '00000000-0000-4000-8000-0000000007e1';
export const USERS = '/admin/v1/users';
export const EXPORTS = '/admin/v1/exports';
export const VERIFY = '/admin/v1/auth/step-up';
/** The first user of the list. */
export const UID = '00000000-0000-4000-8000-00000000e0c1';
/** The second user of the list. */
export const OTHER_UID = '00000000-0000-4000-8000-00000000e0c2';
/** The one user of every later page. */
export const LATER_UID = '00000000-0000-4000-8000-00000000e0c3';
export const DETAIL = `${USERS}/${UID}`;
/** Shown on the detail once it has loaded (invite code). */
export const INVITE_CODE = 'EXP7JE';
/** The totp code the fake step-up accepts. */
export const OTP = '123456';
/** A reason the operator types (neutral words: no 导出 / 创建 / 成功). */
export const REASON = '配合核查注册资料调取手机号';
export const REASON_MAX = 200;
/** The creator the fake writes into a task (never sent by the page). */
export const CREATOR = '00000000-0000-4000-8000-00000000a0e1';

export type UserRow = Schema<'AdminUserListItem'>;
export type UserDetail = Schema<'AdminUserDetail'>;
export type RiskState = Schema<'AdminUserRiskStateCode'>;
export type ExportTask = Schema<'AdminExport'>;

export const RISK_STATES: readonly RiskState[] = ['normal', 'frozen', 'appealing', 'banned'];
/** Names of the risk states in the list's 风控状态 filter (texts/users.ts). */
export const RISK_NAME: Readonly<Record<RiskState, string>> = {
  normal: '正常',
  frozen: '已冻结',
  appealing: '申诉中',
  banned: '已封禁',
};

export interface RequestLog {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: Headers;
  readonly body: unknown;
}
export type Reply = (request: RequestLog) => Response | Promise<Response>;

const HTTP_STATUS: Readonly<Record<number, number>> = {
  10003: 403,
  10403: 403,
  20001: 400,
  20002: 400,
};
const MESSAGES: Readonly<Record<number, string>> = {
  10003: '需要二次验证',
  10403: '无权限',
  20001: '参数错误',
};

export function ok(data: unknown, status = 200): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID }, { status });
}
export function failure(code: number, data: unknown = null): Response {
  return Response.json(
    { code, msg: MESSAGES[code] ?? '操作失败', data, trace_id: TRACE_ID },
    { status: HTTP_STATUS[code] ?? 400 },
  );
}
/** A fetch that never reaches the server (the browser's network error). */
export function offline(): Promise<Response> {
  return Promise.reject(new TypeError('Failed to fetch'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BODY_KEYS = new Set(['resource', 'filters', 'unmasked', 'reason']);

function userDetail(): UserDetail {
  return {
    user_id: UID,
    nickname: '导出样例用户',
    phone_masked: '138****0701',
    invite_code: INVITE_CODE,
    inviter_user_id: null,
    level: 'L1',
    register_method: 'sms',
    registered_channel: null,
    created_at: '2026-10-12T09:00:00Z',
    risk: {
      state: 'normal',
      reason_category: null,
      reason: null,
      frozen_until: null,
      changed_by: null,
      changed_at: null,
      row_version: null,
    },
    union_bindings: [],
  };
}

function firstPage(): UserRow[] {
  return [
    {
      user_id: UID,
      nickname: '导出样例用户',
      phone_masked: '138****0701',
      level: 'L1',
      risk_state: 'normal',
      created_at: '2026-10-12T09:00:00Z',
    },
    {
      user_id: OTHER_UID,
      nickname: '另一位样例用户',
      phone_masked: '139****0702',
      level: 'L1',
      risk_state: 'frozen',
      created_at: '2026-10-11T09:00:00Z',
    },
  ];
}
function laterPage(): UserRow[] {
  return [
    {
      user_id: LATER_UID,
      nickname: '后页样例用户',
      phone_masked: '137****0703',
      level: 'L1',
      risk_state: 'normal',
      created_at: '2026-10-01T09:00:00Z',
    },
  ];
}

export interface ServerOptions {
  /** POST /admin/v1/exports may be sent (the test presses 【导出】). */
  readonly exports?: boolean;
  /** POST /admin/v1/auth/step-up may be sent (only the full-number path). */
  readonly stepUp?: boolean;
  /**
   * GET /admin/v1/exports may be sent (the test opens 导出记录); without it only once a task
   * exists.
   */
  readonly records?: boolean;
  /** GET of the user detail may be sent (the test opens 【详情】). */
  readonly detail?: boolean;
  /** `total` of the list (more than one page when above the page size). */
  readonly total?: number;
}

/**
 * Fake /admin/v1: the users list, one user's detail, the totp step-up, adminCreateExport (202 with
 * a pending task, checks in the contract's order) and adminListExports.
 */
export function createServer(options: ServerOptions = {}) {
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  /** Tasks created, newest first. */
  const tasks: ExportTask[] = [];
  /** Step-up grants handed out, in order. */
  const issued: string[] = [];
  /** Grants a request already carried (each one is good for one request). */
  const spent = new Set<string>();
  const total = options.total ?? 2;
  /** Reads of 导出记录 sent once a task exists (a page may go there after creating one). */
  const afterTask = new Set<RequestLog>();
  let pending = 0;

  /** adminCreateExport for resource=users as the contract describes it. */
  function createExport(request: RequestLog): Response {
    const body = request.body;
    if (!isRecord(body) || Object.keys(body).some((key) => !BODY_KEYS.has(key)))
      return failure(20001, { fields: ['body'] });
    if (body['resource'] !== 'users') return failure(20001, { fields: ['resource'] });
    const filters = body['filters'] ?? {};
    if (
      !isRecord(filters) ||
      Object.keys(filters).some((key) => key !== 'risk_state') ||
      (filters['risk_state'] !== undefined &&
        !RISK_STATES.includes(filters['risk_state'] as RiskState))
    )
      return failure(20001, { fields: ['filters'] });
    const unmasked = body['unmasked'];
    if (unmasked !== undefined && typeof unmasked !== 'boolean')
      return failure(20001, { fields: ['unmasked'] });
    if (unmasked === true) {
      const pass = request.headers.get('X-Step-Up-Token');
      if (pass === null || !issued.includes(pass) || spent.has(pass))
        return failure(10003, { tier: 'totp' });
      spent.add(pass);
      const reason = body['reason'];
      if (typeof reason !== 'string' || reason.length < 1 || reason.length > REASON_MAX)
        return failure(20001, { fields: ['reason'] });
    } else if (Object.hasOwn(body, 'reason')) {
      return failure(20001, { fields: ['reason'] });
    }
    const state = filters['risk_state'] as RiskState | undefined;
    const task: ExportTask = {
      id: `exp_fake${String(tasks.length + 1).padStart(12, '0')}`,
      resource: 'users',
      filters_summary: `风控状态：${state === undefined ? '全部' : RISK_NAME[state]}`,
      masked: unmasked !== true,
      created_by: CREATOR,
      created_by_name: 'ops-yi',
      created_at: '2026-11-01T03:00:00Z',
      status: 'pending',
      progress: null,
      failure_reason: null,
      file_name: null,
      row_count: null,
      expires_at: null,
    };
    tasks.unshift(task);
    return ok(structuredClone(task), 202);
  }

  function normal(request: RequestLog): Response {
    const { method, path, query } = request;
    if (method === 'GET' && (path === USERS || path === EXPORTS)) {
      const page = Number(query['page']);
      const size = Number(query['page_size']);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 200)
        return failure(20001, { fields: ['page_size'] });
      if (path === EXPORTS) {
        const items = page === 1 ? structuredClone(tasks) : [];
        return ok({ items, page, page_size: size, total: tasks.length });
      }
      return ok({ items: page === 1 ? firstPage() : laterPage(), page, page_size: size, total });
    }
    if (method === 'GET' && path === DETAIL) return ok(userDetail());
    if (method === 'POST' && path === VERIFY) {
      const body = request.body;
      if (!isRecord(body) || body['tier'] !== 'totp' || body['code'] !== OTP) return failure(20002);
      const grant = `stepup-pass-${issued.length + 1}`;
      issued.push(grant);
      return ok({ step_up_token: grant, tier: 'totp', expire_at: '2099-01-01T00:00:00Z' });
    }
    if (method === 'POST' && path === EXPORTS) return createExport(request);
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
    if (request.method === 'GET' && request.path === EXPORTS && tasks.length > 0)
      afterTask.add(request);
    pending += 1;
    try {
      const index = overrides.findIndex(
        (entry) => entry.method === request.method && entry.path === request.path,
      );
      const override = index < 0 ? undefined : overrides.splice(index, 1)[0];
      return await (override === undefined ? normal(request) : override.reply(request));
    } finally {
      pending -= 1;
    }
  };

  function isAllowed(request: RequestLog): boolean {
    const { method, path } = request;
    if (method === 'GET' && path === USERS) return true;
    if (method === 'GET' && path === DETAIL) return options.detail === true;
    if (method === 'GET' && path === EXPORTS)
      return options.records === true || afterTask.has(request);
    if (method === 'POST' && path === VERIFY) return options.stepUp === true;
    if (method === 'POST' && path === EXPORTS) return options.exports === true;
    return false;
  }

  return {
    log,
    tasks,
    issued,
    fetch,
    get pending() {
      return pending;
    },
    requests(method: string, path?: string) {
      return log.filter(
        (request) => request.method === method && (path === undefined || request.path === path),
      );
    },
    /** POST /admin/v1/exports sent. */
    exportPosts() {
      return log.filter((request) => request.method === 'POST' && request.path === EXPORTS);
    },
    /** GET /admin/v1/users sent (their queries). */
    listQueries() {
      return log
        .filter((request) => request.method === 'GET' && request.path === USERS)
        .map((request) => request.query);
    },
    /** Every request other than a GET. */
    nonReads() {
      return log.filter((request) => request.method !== 'GET');
    },
    verifies() {
      return log.filter((request) => request.method === 'POST' && request.path === VERIFY);
    },
    /** Requests outside the list read and what this test declared. */
    strays() {
      return log.filter((request) => !isAllowed(request)).map((r) => `${r.method} ${r.path}`);
    },
    /** Answers the next `method` `path` with `reply`. */
    once(method: string, path: string, reply: Reply): void {
      overrides.push({ method, path, reply });
    },
    /** Holds the next `method` `path` until the returned function is called; then answers it. */
    hold(method: string, path: string): () => void {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        reply: async (request) => {
          await gate.promise;
          return normal(request);
        },
      });
      return () => gate.resolve();
    },
  };
}
export type Server = ReturnType<typeof createServer>;
