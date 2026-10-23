import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  ACCOUNT_ID_WEB_GRANT,
  BASE_URL,
  LIST as ACCOUNTS,
  MANUAL_ID,
  NONE_ID,
  NOW,
  PHONES,
  VERIFY,
  failure,
  ok,
  rows as accountRows,
} from '../admin-unions/fixtures.ts';

// Contract fixtures (contracts/openapi.yaml tag admin-unions, CT-24h: adminListUnionPids,
// adminCreateUnionPid, adminUpdateUnionPid, adminActivateUnionPid, adminRetireUnionPid). The PIDs,
// site ids and accounts are samples, not recordings of a real union.
export { ACCOUNTS, BASE_URL, NOW, PHONES, VERIFY, failure, ok };
export const PIDS = '/admin/v1/union-pids';
/** 「测试 OAuth 账号」 (taobao), 「测试手工账号」 (jd), 「测试免授权账号」 (pdd). */
export const TAOBAO_ACCOUNT = ACCOUNT_ID_WEB_GRANT;
export const JD_ACCOUNT = MANUAL_ID;
export const PDD_ACCOUNT = NONE_ID;
export const TAOBAO_NAME = '测试 OAuth 账号';
export const JD_NAME = '测试手工账号';
export const PDD_NAME = '测试免授权账号';

/** taobao · self_buy · active (row_version 1). */
export const ACTIVE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6d01';
/** jd · share · pending (row_version 0). */
export const PENDING_JD_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6d02';
/** taobao · share · retired (row_version 2). */
export const RETIRED_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6d03';
/** taobao · self_buy · pending (row_version 3): activating it meets the active one (30155). */
export const PENDING_TAOBAO_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6d04';
export const SITE = '3001';
export const PID = {
  active: '2001',
  pendingJd: '4002',
  retired: '2003',
  pendingTaobao: '2004',
} as const;
export const ACTIVE_CONFIRMED_AT = '2026-09-28T15:00:00+08:00';

export const pidUrl = (id: string): string => `${PIDS}/${id}`;
export const activateUrl = (id: string): string => `${PIDS}/${id}/activate`;
export const retireUrl = (id: string): string => `${PIDS}/${id}/retire`;

/** The five changeable fields of PATCH (AdminUnionPidUpdateRequest). */
export const PID_FIELDS = ['platform', 'union_account_id', 'site_id', 'pid', 'pid_scene'] as const;
/** The parts of POST …/activate (AdminUnionPidActivateRequest). */
export const ACTIVATE_PARTS = [
  'expected_row_version',
  'hjy_ignore_confirmed_at',
  'hjy_ignore_evidence',
  'reason',
] as const;
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

export type Pid = Schema<'AdminUnionPid'>;
export type Account = Schema<'AdminUnionAccount'>;

export function pids(): Pid[] {
  return [
    {
      pid_id: PENDING_JD_ID,
      platform: 'jd',
      union_account_id: JD_ACCOUNT,
      site_id: null,
      pid: PID.pendingJd,
      pid_scene: 'share',
      status: 'pending',
      hjy_ignore_confirmed_at: null,
      hjy_ignore_evidence_path: null,
      row_version: 0,
      created_at: '2026-10-20T11:00:00+08:00',
    },
    {
      pid_id: ACTIVE_ID,
      platform: 'taobao',
      union_account_id: TAOBAO_ACCOUNT,
      site_id: SITE,
      pid: PID.active,
      pid_scene: 'self_buy',
      status: 'active',
      hjy_ignore_confirmed_at: ACTIVE_CONFIRMED_AT,
      hjy_ignore_evidence_path: `union-pids/${ACTIVE_ID}/hjy.png`,
      row_version: 1,
      created_at: '2026-09-29T00:00:00+08:00',
    },
    {
      pid_id: PENDING_TAOBAO_ID,
      platform: 'taobao',
      union_account_id: TAOBAO_ACCOUNT,
      site_id: SITE,
      pid: PID.pendingTaobao,
      pid_scene: 'self_buy',
      status: 'pending',
      hjy_ignore_confirmed_at: null,
      hjy_ignore_evidence_path: null,
      row_version: 3,
      created_at: '2026-10-21T09:00:00+08:00',
    },
    {
      pid_id: RETIRED_ID,
      platform: 'taobao',
      union_account_id: TAOBAO_ACCOUNT,
      site_id: SITE,
      pid: PID.retired,
      pid_scene: 'share',
      status: 'retired',
      hjy_ignore_confirmed_at: '2026-08-01T10:00:00+08:00',
      hjy_ignore_evidence_path: `union-pids/${RETIRED_ID}/hjy.png`,
      row_version: 2,
      created_at: '2026-07-30T10:00:00+08:00',
    },
  ];
}

export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  /** Parsed JSON body; undefined for no body or a multipart body. */
  body: unknown;
  /** The multipart body as sent (FormData), if any. */
  form: FormData | undefined;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;

const CODE = /^[0-9A-Za-z_-]{1,64}$/;
const SCENES: readonly string[] = ['self_buy', 'agent', 'share', 'taolijin', 'fallback', 'query'];

/**
 * Fake /admin/v1 server: union accounts and alert phones (read only, for the 联盟账号 tab), the
 * union-pids endpoints with the contract's checks, and totp step-up. A step-up value is good for
 * the next write only once; any other value (none, an old one, a reused one) is 10003.
 */
export function createServer(initial: Pid[] = pids(), accounts: Account[] = accountRows()) {
  const state = structuredClone(initial);
  const accountState = structuredClone(accounts);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  const spent = new Set<string>();
  let issued = 0;
  let created = 0;
  let pending = 0;

  function presented(request: RequestLog): boolean {
    const value = request.headers.get('X-Step-Up-Token');
    if (value === null || value !== `test-totp-${issued}` || spent.has(value)) return false;
    spent.add(value);
    return true;
  }

  function account(id: unknown): Account | undefined {
    return accountState.find((item) => item.union_account_id === id);
  }

  /** The checks of POST (and of a row after PATCH): the first failing field, or null. */
  function invalid(row: Record<string, unknown>, self: string | null): string | null {
    const platform = row['platform'];
    if (typeof platform !== 'string' || !['taobao', 'jd', 'pdd'].includes(platform))
      return 'platform';
    const owner = account(row['union_account_id']);
    if (owner === undefined || owner.platform !== platform) return 'union_account_id';
    const site = row['site_id'];
    if (platform === 'taobao' && (typeof site !== 'string' || !CODE.test(site))) return 'site_id';
    if (platform !== 'taobao' && site !== undefined && site !== null) return 'site_id';
    const pid = row['pid'];
    if (typeof pid !== 'string' || !CODE.test(pid)) return 'pid';
    const scene = row['pid_scene'];
    if (typeof scene !== 'string' || !SCENES.includes(scene)) return 'pid_scene';
    const reason = row['reason'];
    if (
      reason !== undefined &&
      (typeof reason !== 'string' || reason.length < 1 || reason.length > 200)
    )
      return 'reason';
    if (
      state.some(
        (other) => other.pid_id !== self && other.platform === platform && other.pid === pid,
      )
    )
      return 'pid';
    return null;
  }

  function create(body: Record<string, unknown>): Response {
    const field = invalid(body, null);
    if (field !== null) return failure(20001, { fields: [field] });
    created += 1;
    const row: Pid = {
      pid_id: `0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6e0${created}`,
      platform: body['platform'] as Pid['platform'],
      union_account_id: body['union_account_id'] as string,
      site_id: body['platform'] === 'taobao' ? (body['site_id'] as string) : null,
      pid: body['pid'] as string,
      pid_scene: body['pid_scene'] as Pid['pid_scene'],
      status: 'pending',
      hjy_ignore_confirmed_at: null,
      hjy_ignore_evidence_path: null,
      row_version: 0,
      created_at: '2026-10-23T10:00:00+08:00',
    };
    state.push(row);
    return ok(row);
  }

  function update(index: number, body: Record<string, unknown>): Response {
    const current = state[index]!;
    if (current.status !== 'pending' || body['expected_row_version'] !== current.row_version)
      return failure(20902, { resource: 'union_pid' });
    const changes = Object.fromEntries(
      Object.entries(body).filter(([key]) => (PID_FIELDS as readonly string[]).includes(key)),
    );
    if (Object.keys(changes).length === 0) return failure(20001, { fields: ['body'] });
    const next = { ...current, ...changes };
    const field = invalid({ ...next, reason: body['reason'] }, current.pid_id);
    if (field !== null) return failure(20001, { fields: [field] });
    state[index] = { ...(next as Pid), row_version: current.row_version + 1 };
    return ok(state[index]);
  }

  function activate(index: number, form: FormData | undefined): Response {
    const current = state[index]!;
    const at = form?.get('hjy_ignore_confirmed_at');
    const evidence = form?.get('hjy_ignore_evidence');
    const missing = [
      ...(typeof at === 'string' && at !== '' ? [] : ['hjy_ignore_confirmed_at']),
      ...(evidence instanceof Blob && evidence.size > 0 ? [] : ['hjy_ignore_evidence']),
    ];
    if (missing.length > 0) return failure(20001, { fields: missing });
    const file = evidence as Blob;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > MAX_EVIDENCE_BYTES)
      return failure(20001, { fields: ['hjy_ignore_evidence'] });
    if (Number.isNaN(Date.parse(at as string)) || Date.parse(at as string) > NOW)
      return failure(20001, { fields: ['hjy_ignore_confirmed_at'] });
    const version = Number(form?.get('expected_row_version'));
    if (current.status !== 'pending' || version !== current.row_version)
      return failure(20902, { resource: 'union_pid' });
    if (
      state.some(
        (other) =>
          other.status === 'active' &&
          other.platform === current.platform &&
          other.pid_scene === current.pid_scene,
      )
    )
      return failure(30155);
    state[index] = {
      ...current,
      status: 'active',
      hjy_ignore_confirmed_at: at as string,
      hjy_ignore_evidence_path: `union-pids/${current.pid_id}/hjy.png`,
      row_version: current.row_version + 1,
    };
    return ok(state[index]);
  }

  function retire(index: number, body: Record<string, unknown>): Response {
    const current = state[index]!;
    if (current.status !== 'active' || body['expected_row_version'] !== current.row_version)
      return failure(20902, { resource: 'union_pid' });
    state[index] = { ...current, status: 'retired', row_version: current.row_version + 1 };
    return ok(state[index]);
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (method === 'GET' && path === ACCOUNTS) return ok({ items: accountState });
    if (method === 'GET' && path === PHONES)
      return ok({ version: 1, items: [{ phone_id: 'hm-existing', phone_masked: '138****5678' }] });
    if (method === 'GET' && path === PIDS) return ok({ items: state });
    if (method === 'POST' && path === VERIFY) {
      const body = request.body as Schema<'AdminStepUpRequest'> | undefined;
      if (body?.tier !== 'totp' || body.code !== '123456') return failure(20002);
      issued += 1;
      return ok({
        step_up_token: `test-totp-${issued}`,
        tier: 'totp',
        expire_at: '2099-01-01T00:00:00Z',
      });
    }
    if (method === 'GET') return failure(20001, { fields: ['path'] });
    if (!presented(request)) return failure(10003, { tier: 'totp' });
    const body =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    if (method === 'POST' && path === PIDS) return create(body);
    const match = /^\/admin\/v1\/union-pids\/([^/]+)(?:\/(activate|retire))?$/.exec(path);
    if (match === null) return failure(20001, { fields: ['path'] });
    const index = state.findIndex((row) => row.pid_id === match[1]);
    if (index < 0) return failure(20001, { fields: ['pid_id'] });
    if (method === 'PATCH' && match[2] === undefined) return update(index, body);
    if (method === 'POST' && match[2] === 'activate') return activate(index, request.form);
    if (method === 'POST' && match[2] === 'retire') return retire(index, body);
    return failure(20001, { fields: ['path'] });
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const request: RequestLog = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined,
      form: raw instanceof FormData ? raw : undefined,
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
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    /** Every request to /admin/v1/union-pids or below it. */
    pidRequests() {
      return log.filter((r) => r.path === PIDS || r.path.startsWith(`${PIDS}/`));
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

/** A screenshot file of `bytes` bytes. */
export function screenshot(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type });
}
