// F1-07jc fixtures: an in-process fake of /admin/v1 for the user detail's union binding actions
// (contracts/openapi.yaml adminGetUser, adminResetUserUnionBinding, adminDisableUserUnionBinding,
// adminEnableUserUnionBinding, adminStepUp). Every call still passes through the real data
// provider. No page module is imported here; the ids are visibly fake.
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';

export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '00000000-0000-4000-8000-0000000007c1';
export const USERS = '/admin/v1/users';
export const VERIFY = '/admin/v1/auth/step-up';
/** The user whose detail is opened. */
export const UID = '00000000-0000-4000-8000-00000000b0c1';
/** A second user of the list; nothing about it may be requested. */
export const OTHER_UID = '00000000-0000-4000-8000-00000000b0c2';
export const DETAIL = `${USERS}/${UID}`;
/** Shown on the detail once it has loaded (invite code). */
export const INVITE_CODE = 'BND7JC';
/** The totp code the fake step-up accepts. */
export const OTP = '123456';
/** A reason the operator types (neutral words: no 成功 / 停用 / 恢复 / 重置). */
export const REASON = '用户来电核实账号信息';
export const REASON_MAX = 200;
export const WRITE_TIME = '2026-11-01T02:00:00Z';
export const COOLDOWN_UNTIL = '2026-12-01T02:00:00Z';

export type UserDetail = Schema<'AdminUserDetail'>;
export type UserRow = Schema<'AdminUserListItem'>;
export type Binding = Schema<'AdminUserUnionBinding'>;
export type BindingStatus = Binding['status'];
export type BlockedReason = NonNullable<Binding['blocked_reason']>;
export type RiskState = Schema<'AdminUserRiskStateCode'>;
export type Platform = 'taobao' | 'pdd';
export type Action = 'reset' | 'disable' | 'enable';
export type Write = `${Platform}/${Action}`;

export const PLATFORMS: readonly Platform[] = ['taobao', 'pdd'];
export const ACTIONS: readonly Action[] = ['reset', 'disable', 'enable'];
/** How the console names a platform (apps/admin texts; the contract has codes only). */
export const PLATFORM_LABEL: Readonly<Record<Platform, string>> = { taobao: '淘宝', pdd: '拼多多' };
/** Status of a binding as the row may show it: the console's name or the raw code. */
export const STATUS_SHOWN: Readonly<Record<BindingStatus, RegExp>> = {
  unbound: /未授权|unbound/,
  pending_auth: /授权中|pending_auth/,
  active: /已授权|(?<![a-z_])active/,
  invalid: /已失效|invalid/,
  released: /已解除|released/,
  blocked: /已停用|blocked/,
};
/** Row versions of the sample rows (distinct, so a mixed-up row shows in the body). */
export const ROW_VERSION: Readonly<Record<Platform, number>> = { taobao: 7, pdd: 4 };

export function bindingPath(platform: string, action: Action, uid = UID): string {
  return `${USERS}/${uid}/union-bindings/${platform}/${action}`;
}

/** A binding row as GET /admin/v1/users/{user_id} returns it. */
export function binding(
  platform: Platform,
  status: BindingStatus,
  blockedReason: BlockedReason | null = status === 'blocked' ? 'admin_disable' : null,
): Binding {
  const bound = status !== 'unbound' && status !== 'pending_auth';
  return {
    platform,
    status,
    blocked_reason: blockedReason,
    bound_at: bound ? '2026-10-12T09:10:00Z' : null,
    released_at: status === 'released' ? '2026-10-20T03:00:00Z' : null,
    cooldown_until: status === 'released' ? '2026-11-19T03:00:00Z' : null,
    reason: null,
    row_version: ROW_VERSION[platform],
  };
}

/** The user detail with the given bindings (risk state normal unless `risk` says otherwise). */
export function userDetail(bindings: readonly Binding[], risk: RiskState = 'normal'): UserDetail {
  return {
    user_id: UID,
    nickname: '授权样例用户',
    phone_masked: '138****0612',
    invite_code: INVITE_CODE,
    inviter_user_id: null,
    level: 'L1',
    register_method: 'sms',
    registered_channel: null,
    created_at: '2026-10-12T09:00:00Z',
    risk:
      risk === 'normal'
        ? {
            state: 'normal',
            reason_category: null,
            reason: null,
            frozen_until: null,
            changed_by: null,
            changed_at: null,
            row_version: null,
          }
        : {
            state: risk,
            reason_category: 'abnormal_trade',
            reason: '人工复核',
            frozen_until: null,
            changed_by: 'ops-yi',
            changed_at: '2026-10-20T03:00:00Z',
            row_version: 0,
          },
    union_bindings: bindings.map((one) => structuredClone(one)),
  };
}

/** taobao active and pdd active: every write entry of a super admin except 【恢复】. */
export function activeUser(): UserDetail {
  return userDetail([binding('taobao', 'active'), binding('pdd', 'active')]);
}

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
  20902: 409,
  30154: 422,
};
const MESSAGES: Readonly<Record<number, string>> = {
  20001: '参数错误',
  20902: '状态已变化，请刷新后重试',
  30154: '该授权当前的状态不允许这项操作，请刷新后查看',
};

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
export function failure(code: number, data: unknown = null): Response {
  return Response.json(
    { code, msg: MESSAGES[code] ?? '操作失败', data, trace_id: TRACE_ID },
    { status: HTTP_STATUS[code] ?? 400 },
  );
}

const WRITE_PATH = /^\/admin\/v1\/users\/([^/]+)\/union-bindings\/([^/]+)\/(reset|disable|enable)$/;

export interface WriteTarget {
  readonly uid: string;
  readonly platform: string;
  readonly action: Action;
}
/** The binding write a request is (POST …/union-bindings/{platform}/{action}), if any. */
export function writeOf(request: Pick<RequestLog, 'method' | 'path'>): WriteTarget | undefined {
  const match = WRITE_PATH.exec(request.path);
  if (match === null) return undefined;
  const [, uid, platform, action] = match;
  if (uid === undefined || platform === undefined || action === undefined) return undefined;
  return { uid, platform, action: action as Action };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The envelope code of a fake answer; -1 when it has no readable envelope. */
async function codeOf(response: Response): Promise<number> {
  try {
    const envelope: unknown = await response.clone().json();
    const code = isRecord(envelope) ? envelope['code'] : undefined;
    return typeof code === 'number' ? code : -1;
  } catch {
    return -1;
  }
}

export interface ServerOptions {
  /** The writes this test may send (anything else is a stray request). */
  readonly writes?: readonly Write[];
}

/** Fake /admin/v1: the users list, this user's detail, the totp step-up and the binding writes. */
export function createServer(initial: UserDetail = activeUser(), options: ServerOptions = {}) {
  const state: UserDetail = structuredClone(initial);
  const log: RequestLog[] = [];
  const answers = new Map<RequestLog, number>();
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  const allowed = new Set<string>(options.writes ?? []);
  /** Step-up grants handed out, in order. */
  const issued: string[] = [];
  /** Grants a write already carried (each one is good for one write). */
  const spent = new Set<string>();
  let pending = 0;

  function listRows(): UserRow[] {
    return [
      {
        user_id: UID,
        nickname: state.nickname,
        phone_masked: state.phone_masked,
        level: state.level,
        risk_state: state.risk.state,
        created_at: state.created_at,
      },
      {
        user_id: OTHER_UID,
        nickname: '另一位样例用户',
        phone_masked: '139****0613',
        level: 'L1',
        risk_state: 'normal',
        created_at: '2026-10-11T09:00:00Z',
      },
    ];
  }

  function applyWrite(request: RequestLog, target: WriteTarget): Response {
    const pass = request.headers.get('X-Step-Up-Token');
    if (pass === null || !issued.includes(pass) || spent.has(pass))
      return failure(10003, { tier: 'totp' });
    spent.add(pass);
    if (target.uid !== UID) return failure(20001, { fields: ['user_id'] });
    const body = request.body;
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== 'reason' && key !== 'expected_row_version')
    )
      return failure(20001, { fields: ['body'] });
    const sent = body['reason'];
    const reason = typeof sent === 'string' ? sent.trim() : '';
    if (reason === '' || reason.length > REASON_MAX) return failure(20001, { fields: ['reason'] });
    const expected = body['expected_row_version'];
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0)
      return failure(20001, { fields: ['expected_row_version'] });
    if (target.platform !== 'taobao' && target.platform !== 'pdd')
      return failure(20001, { fields: ['platform'] });
    if (target.action === 'reset' && target.platform !== 'taobao')
      return failure(20001, { fields: ['platform'] });
    const row = state.union_bindings.find((one) => one.platform === target.platform);
    if (row === undefined) return failure(30154);
    if (expected !== row.row_version) return failure(20902, { resource: 'union_binding' });
    const changeable = row.status === 'active' || row.status === 'invalid';
    if (target.action === 'reset') {
      if (!changeable) return failure(30154);
      Object.assign(row, {
        status: 'released',
        blocked_reason: null,
        released_at: WRITE_TIME,
        cooldown_until: COOLDOWN_UNTIL,
      } satisfies Partial<Binding>);
    } else if (target.action === 'disable') {
      if (!changeable) return failure(30154);
      Object.assign(row, {
        status: 'blocked',
        blocked_reason: 'admin_disable',
      } satisfies Partial<Binding>);
    } else {
      if (row.status !== 'blocked' || row.blocked_reason !== 'admin_disable') return failure(30154);
      if (state.risk.state === 'banned') return failure(30154);
      Object.assign(row, {
        status: target.platform === 'taobao' ? 'invalid' : 'active',
        blocked_reason: null,
      } satisfies Partial<Binding>);
    }
    row.reason = reason;
    row.row_version += 1;
    return ok(structuredClone(row));
  }

  function normal(request: RequestLog): Response {
    const { method, path, query } = request;
    if (method === 'GET' && path === USERS) {
      const page = Number(query['page']);
      const size = Number(query['page_size']);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 200)
        return failure(20001, { fields: ['page_size'] });
      const rows = listRows();
      return ok({ items: page === 1 ? rows : [], page, page_size: size, total: rows.length });
    }
    if (method === 'GET' && path === DETAIL) return ok(structuredClone(state));
    if (method === 'POST' && path === VERIFY) {
      const body = request.body;
      if (!isRecord(body) || body['tier'] !== 'totp' || body['code'] !== OTP) return failure(20002);
      const grant = `stepup-pass-${issued.length + 1}`;
      issued.push(grant);
      return ok({ step_up_token: grant, tier: 'totp', expire_at: '2099-01-01T00:00:00Z' });
    }
    const target = method === 'POST' ? writeOf(request) : undefined;
    if (target !== undefined) return applyWrite(request, target);
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
      const override = index < 0 ? undefined : overrides.splice(index, 1)[0];
      const response = await (override === undefined ? normal(request) : override.reply(request));
      answers.set(request, await codeOf(response));
      return response;
    } finally {
      pending -= 1;
    }
  };

  function isAllowed(request: RequestLog): boolean {
    if (request.method === 'GET' && (request.path === USERS || request.path === DETAIL))
      return true;
    if (request.method === 'POST' && request.path === VERIFY) return true;
    const target = request.method === 'POST' ? writeOf(request) : undefined;
    return (
      target !== undefined &&
      target.uid === UID &&
      allowed.has(`${target.platform}/${target.action}`)
    );
  }

  return {
    state,
    log,
    issued,
    fetch,
    normal,
    get pending() {
      return pending;
    },
    requests(method: string, path?: string) {
      return log.filter(
        (request) => request.method === method && (path === undefined || request.path === path),
      );
    },
    /** The binding writes sent (of `platform` / `action`, when given). */
    writes(platform?: Platform, action?: Action) {
      return log.filter((request) => {
        const target = request.method === 'POST' ? writeOf(request) : undefined;
        return (
          target !== undefined &&
          (platform === undefined || target.platform === platform) &&
          (action === undefined || target.action === action)
        );
      });
    },
    verifies() {
      return log.filter((request) => request.method === 'POST' && request.path === VERIFY);
    },
    detailReads() {
      return log.filter((request) => request.method === 'GET' && request.path === DETAIL);
    },
    /** The envelope code the fake answered `request` with (-1: no envelope, undefined: none yet). */
    answerOf(request: RequestLog): number | undefined {
      return answers.get(request);
    },
    /** Requests outside the list and detail reads, the step-up and the writes this test allows. */
    strays() {
      return log.filter((request) => !isAllowed(request)).map((r) => `${r.method} ${r.path}`);
    },
    /** The current row of `platform` in the server's state. */
    row(platform: Platform): Binding | undefined {
      return state.union_bindings.find((one) => one.platform === platform);
    },
    /** Someone else changed the row of `platform` (row_version moves on). */
    changeElsewhere(platform: Platform, patch: Partial<Binding>): void {
      const row = state.union_bindings.find((one) => one.platform === platform);
      if (row === undefined) throw new Error(`no ${platform} row in the fake state`);
      Object.assign(row, patch);
      row.row_version += 1;
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
