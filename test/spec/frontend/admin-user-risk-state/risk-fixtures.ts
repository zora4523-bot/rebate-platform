// F1-07jd fixtures: an in-process fake of /admin/v1 for the user detail's risk-state actions
// (contracts/openapi.yaml adminGetUser, adminUpdateUserRiskState, adminStepUp). Every call still
// passes through the real data provider. No page module is imported here; the ids are visibly fake.
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';

export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '00000000-0000-4000-8000-0000000007d1';
export const USERS = '/admin/v1/users';
export const VERIFY = '/admin/v1/auth/step-up';
/** The user whose detail is opened. */
export const UID = '00000000-0000-4000-8000-00000000d0c1';
/** A second user of the list; nothing about it may be requested. */
export const OTHER_UID = '00000000-0000-4000-8000-00000000d0c2';
export const DETAIL = `${USERS}/${UID}`;
/** PUT /admin/v1/users/{user_id}/risk-state of the opened user. */
export const RISK_PATH = `${DETAIL}/risk-state`;
/** Shown on the detail once it has loaded (invite code). */
export const INVITE_CODE = 'RSK7JD';
/** The totp code the fake step-up accepts. */
export const OTP = '123456';
/** A reason the operator types (neutral words: no 冻结 / 封禁 / 解 / 成功). */
export const REASON = '运营复核后人工处理';
export const REASON_MAX = 200;
export const WRITE_TIME = '2026-11-01T03:00:00Z';
/** Who changed the risk state in the fake's answers. */
export const OPERATOR = 'ops-yi';

export type UserDetail = Schema<'AdminUserDetail'>;
export type UserRow = Schema<'AdminUserListItem'>;
export type RiskRow = Schema<'AdminUserRiskState'>;
export type RiskState = Schema<'AdminUserRiskStateCode'>;
export type Category = Schema<'AdminRiskReasonCategory'>;
export type RiskAction = Schema<'AdminUserRiskStateAction'>;
export type Binding = Schema<'AdminUserUnionBinding'>;

export const RISK_ACTIONS: readonly RiskAction[] = ['freeze', 'unfreeze', 'ban', 'unban'];
export const CATEGORIES: readonly Category[] = [
  'malicious_rights',
  'fraud_invite',
  'abnormal_trade',
  'account_security',
  'other',
];
/** Names of contracts/enums/identity.yaml risk_reason_category (the console may show the code). */
export const CATEGORY_NAME: Readonly<Record<Category, string>> = {
  malicious_rights: '异常售后维权',
  fraud_invite: '异常邀请行为',
  abnormal_trade: '异常交易',
  account_security: '账户安全核验',
  other: '违反用户协议',
};
/** The category's name or its code, as a pattern. */
export function categoryShown(code: Category): RegExp {
  return new RegExp(`${CATEGORY_NAME[code]}|(?<![a-z_])${code}(?![a-z_])`);
}

/** A Beijing wall-clock time the operator picks. */
export interface WallTime {
  readonly date: string;
  readonly time: string;
}
/** A freeze end well after any run of these tests. */
export const LATER: WallTime = { date: '2030-12-31', time: '23:59' };
/** A freeze end that has long passed. */
export const EARLIER: WallTime = { date: '2020-01-01', time: '08:00' };

/** `value` is an ISO date-time with a zone (Z or ±hh:mm). */
export function hasZone(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /T\d{2}:\d{2}/.test(value) &&
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
/**
 * `value` is the minute `wall` read as Beijing time (+08:00, or the same instant in UTC), seconds
 * 0–59 allowed. A time read in the machine's own zone does not count.
 */
export function sameMinute(value: unknown, wall: WallTime): boolean {
  if (typeof value !== 'string') return false;
  const at = Date.parse(value);
  const [year, month, day] = wall.date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = wall.time.split(':').map(Number) as [number, number];
  const beijing = Date.UTC(year, month - 1, day, hour - 8, minute);
  return at >= beijing && at < beijing + 60_000;
}

/** The name a control goes by: its aria-label, else its text (spaces removed). */
function controlName(node: Element): string {
  const label = node.getAttribute('aria-label');
  const own = label !== null && label.trim() !== '' ? label : node.textContent;
  return (own ?? '').replace(/\s+/g, '');
}
const FREEZE_FIRST = /^冻结/;
const BAN_FIRST = /^封禁/;
/** Of `named`, the ones naming 冻结 / 封禁 first, when both are there (a pair of choices). */
function pairOf(named: readonly { node: HTMLElement; name: string }[]): HTMLElement[] {
  const prefixed = named.filter(({ name }) => FREEZE_FIRST.test(name) || BAN_FIRST.test(name));
  const both = (list: typeof prefixed) =>
    list.some(({ name }) => FREEZE_FIRST.test(name)) &&
    list.some(({ name }) => BAN_FIRST.test(name));
  if (!both(prefixed)) return [];
  // Choices that also describe themselves (the board: 「冻结 只暂停提现，可设期限」); a bare
  // 「冻结」 button beside them is then the submit.
  const described = prefixed.filter(({ name }) => name.length > 2);
  return (both(described) ? described : prefixed).map(({ node }) => node);
}
/**
 * The 处理方式 choices (冻结 / 封禁) of a dialog that does both, as the board AdmUserFreeze draws
 * it (radios, segmented items or buttons); empty for a dialog of one action. Each choice is
 * returned as its outermost part (the radio's label, or the button).
 */
export function modeChoices(dialog: Element): HTMLElement[] {
  const radios = Array.from(
    dialog.querySelectorAll<HTMLElement>('input[type="radio"], [role="radio"], [role="tab"]'),
  ).map((node) => {
    const holder = node.closest<HTMLElement>('label') ?? node;
    return { node: holder, name: controlName(holder) };
  });
  const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button, [role="button"]'))
    .filter((node) => node.closest('label, .ant-modal-close') === null)
    .map((node) => ({ node, name: controlName(node) }));
  return [...new Set([...pairOf(radios), ...pairOf(buttons)])];
}
/** `node` is (inside) one of the 处理方式 choices of `dialog`. */
export function inModeChoice(dialog: Element, node: Node): boolean {
  return modeChoices(dialog).some((choice) => choice.contains(node));
}

/** The risk part of a user without a risk-state row (contract: normal, nulls, row_version null). */
export function noRow(): RiskRow {
  return {
    state: 'normal',
    reason_category: null,
    reason: null,
    frozen_until: null,
    changed_by: null,
    changed_at: null,
    row_version: null,
  };
}
/** A risk-state row in `state` at `rowVersion`. */
export function riskRow(
  state: RiskState,
  rowVersion: number,
  patch: Partial<RiskRow> = {},
): RiskRow {
  const held = state !== 'normal';
  return {
    state,
    reason_category: held ? 'abnormal_trade' : null,
    reason: '人工复核记录',
    frozen_until: state === 'frozen' ? '2030-06-30T15:59:00Z' : null,
    changed_by: 'ops-er',
    changed_at: '2026-10-20T03:00:00Z',
    row_version: rowVersion,
    ...patch,
  };
}

/** Row versions of the sample users (distinct, so a mixed-up value shows in the body). */
export const ROW = { normal: 5, frozen: 2, banned: 7, appealing: 4 } as const;

function bindingsFor(state: RiskState): Binding[] {
  return [
    {
      platform: 'taobao',
      status: state === 'banned' ? 'blocked' : 'active',
      blocked_reason: state === 'banned' ? 'ban' : null,
      bound_at: '2026-10-12T09:10:00Z',
      released_at: null,
      cooldown_until: null,
      reason: null,
      row_version: 3,
    },
  ];
}

/** The user detail with the risk part `risk`. */
export function userDetail(risk: RiskRow = noRow()): UserDetail {
  return {
    user_id: UID,
    nickname: '风控样例用户',
    phone_masked: '138****0701',
    invite_code: INVITE_CODE,
    inviter_user_id: null,
    level: 'L1',
    register_method: 'sms',
    registered_channel: null,
    created_at: '2026-10-12T09:00:00Z',
    risk: structuredClone(risk),
    union_bindings: bindingsFor(risk.state),
  };
}
/** A user in `state` with a row (normal: a row left by an earlier unfreeze / unban). */
export function userIn(state: RiskState): UserDetail {
  return userDetail(riskRow(state, ROW[state]));
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
  44004: 403,
};
const MESSAGES: Readonly<Record<number, string>> = {
  20001: '参数错误',
  20902: '状态已变化，请刷新后重试',
  44004: '用户当前的风控状态不允许这项操作，请刷新后查看',
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

const WRITE_PATH = /^\/admin\/v1\/users\/([^/]+)\/risk-state$/;
const BODY_KEYS = new Set([
  'action',
  'reason',
  'reason_category',
  'frozen_until',
  'expected_row_version',
]);

/** The user a risk-state write is for (PUT …/users/{user_id}/risk-state), if it is one. */
export function writeTarget(request: Pick<RequestLog, 'method' | 'path'>): string | undefined {
  if (request.method !== 'PUT') return undefined;
  return WRITE_PATH.exec(request.path)?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** The `action` a write body names, if any. */
export function actionOf(request: RequestLog): string | undefined {
  const body = request.body;
  const action = isRecord(body) ? body['action'] : undefined;
  return typeof action === 'string' ? action : undefined;
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
  /** The risk actions this test may send (anything else is a stray request). */
  readonly writes?: readonly RiskAction[];
}

/** Fake /admin/v1: the users list, this user's detail, the totp step-up and the risk-state PUT. */
export function createServer(initial: UserDetail = userDetail(), options: ServerOptions = {}) {
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
        phone_masked: '139****0702',
        level: 'L1',
        risk_state: 'normal',
        created_at: '2026-10-11T09:00:00Z',
      },
    ];
  }

  function setBindings(action: RiskAction): void {
    for (const one of state.union_bindings) {
      if (action === 'ban' && (one.status === 'active' || one.status === 'invalid')) {
        one.status = 'blocked';
        one.blocked_reason = 'ban';
        one.row_version += 1;
      }
      if (action === 'unban' && one.status === 'blocked' && one.blocked_reason === 'ban') {
        one.status = one.platform === 'taobao' ? 'invalid' : 'active';
        one.blocked_reason = null;
        one.row_version += 1;
      }
    }
  }

  /** adminUpdateUserRiskState as the contract describes it (checks in the contract's order). */
  function applyWrite(request: RequestLog, uid: string): Response {
    const pass = request.headers.get('X-Step-Up-Token');
    if (pass === null || !issued.includes(pass) || spent.has(pass))
      return failure(10003, { tier: 'totp' });
    spent.add(pass);
    if (uid !== UID) return failure(20001, { fields: ['user_id'] });
    const body = request.body;
    if (!isRecord(body) || Object.keys(body).some((key) => !BODY_KEYS.has(key)))
      return failure(20001, { fields: ['body'] });
    const action = body['action'];
    if (action !== 'ban' && action !== 'unban' && action !== 'freeze' && action !== 'unfreeze')
      return failure(20001, { fields: ['action'] });
    // The contract: 1–200 characters; it says nothing of trimming, so blanks count as characters.
    const sent = body['reason'];
    if (typeof sent !== 'string' || sent.length < 1 || sent.length > REASON_MAX)
      return failure(20001, { fields: ['reason'] });
    const holds = action === 'ban' || action === 'freeze';
    const category = body['reason_category'];
    if (holds && !CATEGORIES.includes(category as Category))
      return failure(20001, { fields: ['reason_category'] });
    if (!holds && Object.hasOwn(body, 'reason_category'))
      return failure(20001, { fields: ['reason_category'] });
    const until = body['frozen_until'];
    if (action !== 'freeze' && Object.hasOwn(body, 'frozen_until'))
      return failure(20001, { fields: ['frozen_until'] });
    const endless = until === undefined || until === null;
    if (!endless && (!hasZone(until) || Date.parse(until) <= Date.now()))
      return failure(20001, { fields: ['frozen_until'] });
    if (!Object.hasOwn(body, 'expected_row_version'))
      return failure(20001, { fields: ['expected_row_version'] });
    const expected = body['expected_row_version'];
    if (
      expected !== null &&
      (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0)
    )
      return failure(20001, { fields: ['expected_row_version'] });
    if (expected !== state.risk.row_version) return failure(20902, { resource: 'user_risk_state' });
    const from = state.risk.state;
    const permitted =
      from !== 'appealing' &&
      (action === 'ban' || action === 'freeze'
        ? from === 'normal' || from === 'frozen'
        : action === 'unban'
          ? from === 'banned'
          : from === 'frozen');
    if (!permitted) return failure(44004);
    state.risk = {
      state: action === 'ban' ? 'banned' : action === 'freeze' ? 'frozen' : 'normal',
      reason_category: holds ? (category as Category) : null,
      reason: sent,
      frozen_until: action === 'freeze' && typeof until === 'string' ? until : null,
      changed_by: OPERATOR,
      changed_at: WRITE_TIME,
      row_version: (state.risk.row_version ?? -1) + 1,
    };
    setBindings(action);
    return ok(structuredClone(state.risk));
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
    const uid = writeTarget(request);
    if (uid !== undefined) return applyWrite(request, uid);
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
    const action = actionOf(request);
    return writeTarget(request) === UID && action !== undefined && allowed.has(action);
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
    /** Risk-state writes sent (of `action`, when given). */
    writes(action?: RiskAction) {
      return log.filter(
        (request) =>
          writeTarget(request) !== undefined &&
          (action === undefined || actionOf(request) === action),
      );
    },
    /** Every request other than a GET (writes, step-ups, anything else). */
    nonReads() {
      return log.filter((request) => request.method !== 'GET');
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
      return log
        .filter((request) => !isAllowed(request))
        .map((r) => `${r.method} ${r.path} ${actionOf(r) ?? ''}`.trim());
    },
    /** The risk part of the user as the server has it now. */
    risk(): RiskRow {
      return state.risk;
    },
    /** Someone else changed the risk state (row_version moves on). */
    changeElsewhere(patch: Partial<RiskRow>): void {
      state.risk = {
        ...state.risk,
        changed_by: 'ops-other',
        changed_at: '2026-11-01T02:30:00Z',
        ...patch,
        row_version: (state.risk.row_version ?? -1) + 1,
      };
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
