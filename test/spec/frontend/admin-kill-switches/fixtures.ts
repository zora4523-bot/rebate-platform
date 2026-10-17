import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { BASE_URL, TRACE_ID } from '../admin-data/fixtures.ts';

export { BASE_URL };
export type SwitchRow = Schema<'AdminKillSwitch'>;
export const LIST = '/admin/v1/kill-switches';
export const VERIFY = '/admin/v1/auth/step-up';
export const GROUPS = ['转链与搜索', 'AI 助手', '提现与打款', '结算、找回与其他'] as const;
export const AUTO = 'withdraw.auto_payout.enabled';
export const TARGET = 'convert.enabled.taobao';

/** Independent contract-shaped fixtures; no import from the implementation registry. */
export function item(key: string, patch: Partial<SwitchRow> = {}): SwitchRow {
  return {
    key,
    value: true,
    default: true,
    value_type: 'boolean',
    options: null,
    permissions: ['switch.all'],
    admin_editable: true,
    version: 3,
    updated_by: 'ops-yi',
    updated_at: '2026-10-09T02:00:00Z',
    ...patch,
  };
}

/** Deliberately non-alphabetical within groups, including a server-registered tool name. */
export function rows(): SwitchRow[] {
  return [
    item('convert.enabled.jd', { default: false }),
    item(TARGET, { default: false }),
    item('convert.off_reason.pdd', {
      value: null,
      default: 'not_launched',
      value_type: 'enum',
      options: ['not_launched', 'maintenance'],
      version: 0,
      updated_by: null,
      updated_at: null,
    }),
    item('parse.tpwd.enabled', { value: null, version: 0, updated_by: null, updated_at: null }),
    item('agent.enabled'),
    item('agent.tools.catalog_probe.enabled'),
    item('agent.whitelist_only', { admin_editable: false }),
    item('agent.model_route', {
      value: { primary: 'demo_primary', fallback: 'demo_fallback' },
      default: null,
      value_type: 'object',
      admin_editable: false,
    }),
    item('withdraw.enabled', { permissions: ['switch.all', 'switch.payout'] }),
    item(AUTO, { value: false, default: false }),
    item('payout.enabled', { permissions: ['switch.all', 'switch.payout'] }),
    item('payout.queue_paused', { default: false, permissions: ['switch.all', 'switch.payout'] }),
    item('payout.channel_paused.alipay', {
      default: false,
      permissions: ['switch.all', 'switch.payout'],
    }),
    item('pay.enabled', { permissions: ['switch.all', 'switch.pay'] }),
    item('settle.auto.enabled'),
    item('claims.enabled', { value: false }),
    item('credit.enabled.taobao', {
      value: null,
      default: false,
      version: 0,
      updated_by: null,
      updated_at: null,
    }),
    // Registered prefixes outside the first three groups must remain visible, in this order.
    item('order_sync.promo_mode', { value: false, default: false }),
    item('jev.enabled', { value: false, default: false }),
  ];
}

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
export function failure(code: number, data: unknown = null, msg = '操作失败'): Response {
  return Response.json(
    { code, msg, data, trace_id: TRACE_ID },
    { status: code === 10403 ? 403 : 400 },
  );
}

/** In-process fake HTTP boundary: every call still passes through the real data provider. */
export function createServer(initial = rows()) {
  const state = structuredClone(initial);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let tokens = 0;
  let pending = 0;
  function normal(request: RequestLog): Response {
    if (request.method === 'GET' && request.path === LIST) {
      const page = Number(request.query['page'] ?? 1);
      const pageSize = Number(request.query['page_size'] ?? 20);
      if (
        Object.keys(request.query).some((key) => !['page', 'page_size'].includes(key)) ||
        !Number.isInteger(page) ||
        page < 1 ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 200
      )
        return failure(20001, { fields: ['page_size'] });
      return ok({
        items: state.slice((page - 1) * pageSize, page * pageSize),
        page,
        page_size: pageSize,
        total: state.length,
      });
    }
    if (request.method === 'POST' && request.path === VERIFY) {
      const body = request.body as Schema<'AdminStepUpRequest'>;
      if (body?.tier !== 'totp' || body.code !== '123456') return failure(20002);
      tokens += 1;
      return ok({
        step_up_token: `test-totp-${tokens}`,
        tier: 'totp',
        expire_at: '2099-01-01T00:00:00Z',
      });
    }
    if (request.method === 'PUT' && request.path.startsWith(`${LIST}/`)) {
      const key = decodeURIComponent(request.path.slice(LIST.length + 1));
      const row = state.find((candidate) => candidate.key === key);
      if (!row || !row.admin_editable) return failure(20001, { fields: ['key'] });
      if (request.headers.get('X-Step-Up-Token') !== `test-totp-${tokens}` || tokens === 0)
        return failure(10003, { tier: 'totp' });
      const body = request.body as Schema<'AdminKillSwitchUpdateRequest'>;
      if (body?.expected_version !== row.version)
        return failure(20902, { resource: 'kill_switch' });
      if (
        (key === AUTO && body.value !== false) ||
        (row.value_type === 'boolean' && typeof body.value !== 'boolean') ||
        (row.value_type === 'enum' && !row.options?.includes(String(body.value)))
      )
        return failure(20001, { fields: ['value'] });
      row.value = body.value;
      row.version += 1;
      return ok(row);
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
