import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { BASE_URL, TRACE_ID } from '../admin-data/fixtures.ts';

export { BASE_URL };
export type VersionRow = Schema<'AdminAppVersion'>;
export type SaveBody = Schema<'AdminAppVersionSaveRequest'>;
export const LIST = '/admin/v1/app-versions';
export const TARGET = `${LIST}/android/official`;
export const VERIFY = '/admin/v1/auth/step-up';
// Fictitious store codes, not real integration data.
export const PRIMARY = 'demo_primary';
export const LAGGING = ['demo_slow_a', 'demo_slow_b'];
export const READY = 'demo_ready';
export const PERMITTED: PermissionSnapshot = {
  isSuper: false,
  permissions: ['content.app_version'],
  stepUp: {
    'content.app_version': {
      tier: null,
      operations: { 'content.app_version.raise_min_supported_version': 'totp' },
    },
  },
};

export function item(patch: Partial<VersionRow> = {}): VersionRow {
  return {
    platform: 'android',
    channel: 'official',
    latest_version: '4.12.3',
    min_supported_version: '2.9.0',
    recommended_version: '3.4.0',
    update_title: '演示更新标题',
    update_notes: '演示更新说明\n第二行说明',
    store_url: 'https://stores.example.test/demo',
    default_store: PRIMARY,
    store_listings: [
      { store: PRIMARY, listed_version: '4.12.3' },
      { store: LAGGING[0]!, listed_version: '2.9.0' },
      { store: LAGGING[1]!, listed_version: '2.8.9' },
      { store: READY, listed_version: '2.10.0' },
    ],
    row_version: 7,
    updated_at: '2026-10-22T03:45:00Z',
    ...patch,
  };
}

/** Ordered by platform/channel as the contract promises; latest values identify rows. */
export function rows(): VersionRow[] {
  return [
    item({ platform: 'admin', latest_version: '9.0.1' }),
    item({ channel: 'huawei', latest_version: '4.12.2' }),
    item(),
    item({
      platform: 'h5',
      latest_version: '9.0.2',
      min_supported_version: null,
      recommended_version: null,
    }),
    item({ platform: 'harmony', channel: 'agc', latest_version: '5.0.1' }),
    item({ platform: 'ios', channel: 'appstore', latest_version: '6.0.1' }),
  ].map((row) => ({
    ...row,
    store_listings: row.store_listings.map((listing) =>
      listing.store === PRIMARY ? { ...listing, listed_version: row.latest_version } : listing,
    ),
  }));
}

/** Independent expected wire payload; no production helper is used as the oracle. */
export function payload(row = item(), patch: Partial<SaveBody> = {}): SaveBody {
  return {
    latest_version: row.latest_version,
    min_supported_version: row.min_supported_version,
    recommended_version: row.recommended_version,
    update_title: row.update_title,
    update_notes: row.update_notes,
    store_url: row.store_url,
    default_store: row.default_store,
    store_listings: structuredClone(row.store_listings),
    confirmed_stores: [],
    expected_row_version: row.row_version,
    ...patch,
  };
}
export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
export function failure(code: number, data: unknown = null, msg = '参数错误'): Response {
  return Response.json(
    { code, msg, data, trace_id: TRACE_ID },
    {
      status: code === 10403 ? 403 : code === 30701 ? 404 : code === 20902 ? 409 : 400,
    },
  );
}
export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;

/** Scripted HTTP fake. Tests prescribe refusals; it does not reimplement validation rules. */
export function createServer(initial = rows()) {
  const state = structuredClone(initial);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let pending = 0;
  function normal(request: RequestLog): Response {
    if (request.method === 'GET' && request.path === LIST) return ok({ items: state });
    if (request.method === 'POST' && request.path === VERIFY) {
      return ok({
        step_up_token: 'example-step-up',
        tier: 'totp',
        expire_at: '2099-01-01T00:00:00Z',
      });
    }
    const existing = state.find((row) => request.path === `${LIST}/${row.platform}/${row.channel}`);
    if (request.method === 'GET' && request.path.startsWith(`${LIST}/`))
      return existing ? ok(existing) : failure(30701, null, '内容不存在');
    if (request.method === 'PUT' && request.path.startsWith(`${LIST}/`)) {
      const body = request.body as SaveBody;
      const next = item({
        ...existing,
        latest_version: body.latest_version,
        min_supported_version: body.min_supported_version,
        recommended_version: body.recommended_version,
        update_title: body.update_title,
        update_notes: body.update_notes,
        store_url: body.store_url,
        default_store: body.default_store,
        store_listings: body.store_listings,
        row_version: existing ? existing.row_version + 1 : 0,
      });
      if (existing) Object.assign(existing, next);
      else state.push(next);
      return ok(next);
    }
    return failure(20001, { fields: ['path'] }, 'unexpected test request');
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    const entry: RequestLog = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    };
    log.push(entry);
    pending += 1;
    try {
      const index = overrides.findIndex((r) => r.method === entry.method && r.path === entry.path);
      return await (index < 0 ? normal(entry) : overrides.splice(index, 1)[0]!.reply(entry));
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
