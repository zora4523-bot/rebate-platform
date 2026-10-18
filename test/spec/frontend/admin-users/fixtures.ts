import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { BASE_URL, failure, ok } from '../admin-kill-switches/fixtures.ts';
import type { RequestLog } from '../admin-kill-switches/fixtures.ts';

export { BASE_URL, failure, ok };
export const LIST = '/admin/v1/users';
export const LOOKUP = `${LIST}/lookup`;
export const VERIFY = '/admin/v1/auth/step-up';
export const UID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
export const PARENT = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02';
export const PHONE = '13800005678';
export const REASON = '用户来电核对注册手机号';
export const DETAIL = `${LIST}/${UID}`;
export const REVEAL = `${DETAIL}/reveal`;
export type UserRow = Schema<'AdminUserListItem'>;
export type UserDetail = Schema<'AdminUserDetail'>;
export const RISK_LABELS = {
  normal: '正常',
  frozen: '已冻结',
  appealing: '申诉中',
  banned: '已封禁',
};

export function rows(): UserRow[] {
  return Array.from({ length: 205 }, (_, index) => ({
    user_id:
      index === 0
        ? UID
        : index === 1
          ? PARENT
          : `0199a3b4-5c6d-7e8f-9a0b-${String(index + 10).padStart(12, '0')}`,
    nickname: `测试用户${index + 1}`,
    phone_masked: index === 1 ? null : '138****5678',
    level: index === 0 ? 'L2' : 'L1',
    risk_state: index === 1 ? 'frozen' : 'normal',
    created_at: index === 0 ? '2026-10-12T17:05:00Z' : '2026-10-10T12:30:00Z',
  }));
}

export function detail(row: UserRow = rows()[0]!): UserDetail {
  return {
    user_id: row.user_id,
    nickname: row.nickname,
    phone_masked: row.phone_masked,
    invite_code: row.user_id === UID ? 'K7QX2M' : 'P3RT8N',
    inviter_user_id: row.user_id === UID ? PARENT : null,
    level: row.level,
    register_method: 'sms',
    registered_channel: row.user_id === UID ? 'appstore' : null,
    created_at: row.created_at,
    risk: {
      state: row.risk_state,
      reason_category: row.risk_state === 'normal' ? null : 'abnormal_trade',
      reason: row.risk_state === 'normal' ? null : '人工复核中',
      frozen_until: null,
      changed_by: row.risk_state === 'normal' ? null : 'ops-yi',
      changed_at: row.risk_state === 'normal' ? null : '2026-10-15T03:00:00Z',
      row_version: row.risk_state === 'normal' ? null : 0,
    },
    union_bindings: [
      {
        platform: 'taobao',
        status: 'active',
        blocked_reason: null,
        bound_at: '2026-10-12T17:10:00Z',
        released_at: null,
        cooldown_until: null,
        reason: null,
        row_version: 0,
      },
    ],
  };
}

type Reply = (request: RequestLog) => Response | Promise<Response>;

/** Fake HTTP boundary only; pagination and errors use the public contract, not page helpers. */
export function createServer(initial = rows()) {
  const state = structuredClone(initial);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let pending = 0;
  let tokens = 0;
  function normal(request: RequestLog): Response {
    const { method, path, query } = request;
    if (method === 'GET' && path === LIST) {
      const page = Number(query['page']);
      const size = Number(query['page_size']);
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        !Number.isInteger(size) ||
        size < 1 ||
        size > 200 ||
        Object.keys(query).some((key) => !['page', 'page_size', 'risk_state'].includes(key))
      )
        return failure(20001, { fields: ['page_size'] });
      const filtered = state.filter(
        (row) => query['risk_state'] === undefined || row.risk_state === query['risk_state'],
      );
      return ok({
        items: filtered.slice((page - 1) * size, page * size),
        page,
        page_size: size,
        total: filtered.length,
      });
    }
    if (method === 'GET' && path === LOOKUP) {
      if (Object.keys(query).length !== 1 || (!query['uid'] && !query['phone']))
        return failure(20001, { fields: ['uid', 'phone'] });
      const row = state.find(
        (item) =>
          item.user_id === query['uid'] || (query['phone'] === PHONE && item.user_id === UID),
      );
      return row ? ok(detail(row)) : failure(20001, { fields: [query['uid'] ? 'uid' : 'phone'] });
    }
    if (method === 'GET' && path.startsWith(`${LIST}/`)) {
      const row = state.find((item) => path === `${LIST}/${item.user_id}`);
      return row ? ok(detail(row)) : failure(20001, { fields: ['user_id'] });
    }
    if (method === 'POST' && path === VERIFY) {
      const body = request.body as Schema<'AdminStepUpRequest'>;
      if (body?.tier !== 'totp' || body.code !== '123456') return failure(20002);
      tokens += 1;
      return ok({
        step_up_token: `test-totp-${tokens}`,
        tier: 'totp',
        expire_at: '2099-01-01T00:00:00Z',
      });
    }
    if (method === 'POST' && path === REVEAL) {
      if (!tokens || request.headers.get('X-Step-Up-Token') !== `test-totp-${tokens}`)
        return failure(10003, { tier: 'totp' });
      const body = request.body as Schema<'AdminUserRevealRequest'>;
      if (
        body?.field !== 'phone' ||
        typeof body.reason !== 'string' ||
        !body.reason.trim() ||
        body.reason.length > 200
      )
        return failure(20001, { fields: ['reason'] });
      const response = ok({ user_id: UID, field: 'phone', value: PHONE });
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
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
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
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
