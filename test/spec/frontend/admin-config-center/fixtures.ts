import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { BASE_URL, TRACE_ID } from '../admin-data/fixtures.ts';

export { BASE_URL };
export type ConfigRow = Schema<'AdminConfigItem'>;
export type Version = Schema<'AdminConfigItemVersion'>;
export const LIST = '/admin/v1/config-items';
export const VERIFY = '/admin/v1/auth/step-up';
export const TARGET = 'withdraw.daily_count_per_user';
export const GENERAL = 'favorites.max_per_user';
export const GROUPS = [
  '提现设置',
  '邀请码规则',
  '风控阈值',
  'Agent 额度与预算',
  '模型路由',
  '示例问题',
];
export const REASON = '内测调整配置，核对效果';

/** Contract-shaped values only: the API does NOT provide default, description or scope. */
export function item(key = TARGET, patch: Partial<ConfigRow> = {}): ConfigRow {
  return {
    key,
    value: 3,
    value_type: 'number',
    options: null,
    permission: 'config.business',
    admin_editable: true,
    version: 3,
    updated_by: 'ops-yi',
    updated_at: '2026-10-09T02:00:00Z',
    ...patch,
  };
}
export function rows(): ConfigRow[] {
  return [
    item('withdraw.monthly_count_per_user', { value: 10 }),
    item(),
    item('withdraw.payee_daily_count', {
      value: null,
      version: 0,
      updated_by: null,
      updated_at: null,
    }),
    item(GENERAL, { value: 200, permission: 'config.general' }),
    item('risk.fixture_threshold', { permission: 'config.risk' }),
    item('agent.page_guide.routes', {
      value: ['Wallet'],
      value_type: 'object',
      permission: 'config.general',
      admin_editable: false,
    }),
    item('external_hosts', {
      value: ['demo.invalid'],
      value_type: 'object',
      permission: 'config.general',
      admin_editable: false,
    }),
  ];
}
export function versions(row: ConfigRow): Version[] {
  return row.version === 0
    ? []
    : [
        {
          version: row.version,
          value: row.value,
          updated_by: row.updated_by,
          reason: '当前配置说明',
          created_at: row.updated_at ?? '2026-10-09T02:00:00Z',
        },
        {
          version: 2,
          value: 2,
          updated_by: 'ops-old',
          reason: '上次调整原因',
          created_at: '2026-10-08T02:00:00Z',
        },
        {
          version: 1,
          value: 1,
          updated_by: null,
          reason: null,
          created_at: '2026-10-07T02:00:00Z',
        },
      ].filter((entry, index) => index === 0 || entry.version < row.version);
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

/** In-memory HTTP boundary; assertions inspect real provider requests, never mock the page. */
export function createServer(initial = rows()) {
  const state = structuredClone(initial);
  const history = new Map(state.map((row) => [row.key, versions(row)]));
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let pending = 0;
  let tokens = 0;
  function paged<T>(items: T[], request: RequestLog): Response {
    const page = Number(request.query['page'] ?? 1);
    const pageSize = Number(request.query['page_size'] ?? 20);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 200 ||
      Object.keys(request.query).some((key) => !['page', 'page_size'].includes(key))
    )
      return failure(20001, { fields: ['page_size'] });
    return ok({
      items: items.slice((page - 1) * pageSize, page * pageSize),
      page,
      page_size: pageSize,
      total: items.length,
    });
  }
  function normal(request: RequestLog): Response {
    if (request.method === 'GET' && request.path === LIST) return paged(state, request);
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
    const suffix = decodeURIComponent(request.path.slice(LIST.length + 1));
    const key = suffix.replace(/\/(?:versions|rollback)$/, '');
    const row = state.find((entry) => entry.key === key);
    if (!row) return failure(20001, { fields: ['key'] });
    if (request.method === 'GET')
      return suffix.endsWith('/versions') ? paged(history.get(key) ?? [], request) : ok(row);
    if (request.method === 'PUT' || (request.method === 'POST' && suffix.endsWith('/rollback'))) {
      if (!row.admin_editable) return failure(20001, { fields: ['key'] });
      if (
        row.permission !== 'config.general' &&
        (tokens === 0 || request.headers.get('X-Step-Up-Token') !== `test-totp-${tokens}`)
      )
        return failure(10003, { tier: 'totp' });
      const body = request.body as Schema<'AdminConfigItemUpdateRequest'> &
        Partial<Schema<'AdminConfigItemRollbackRequest'>>;
      if (body.expected_version !== row.version) return failure(20902, { resource: 'config_item' });
      let value = body.value;
      if (suffix.endsWith('/rollback')) {
        const old = history
          .get(key)
          ?.find((entry) => entry.version === body.to_version && entry.version < row.version);
        if (!old) return failure(20001, { fields: ['to_version'] });
        value = old.value;
      }
      row.value = value;
      row.version += 1;
      row.updated_by = 'ops-yi';
      row.updated_at = '2026-10-18T02:00:00Z';
      history.get(key)?.unshift({
        version: row.version,
        value,
        updated_by: row.updated_by,
        reason: body.reason ?? null,
        created_at: row.updated_at,
      });
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
    history,
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
