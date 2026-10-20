import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { RequestLog } from '../admin-kill-switches/fixtures.ts';
import { BASE_URL, ok, failure } from '../admin-users/fixtures.ts';

export { BASE_URL, ok, failure };
export const LOGS = '/admin/v1/audit-logs';
export const EXPORTS = '/admin/v1/exports';
export const AID = 'aud_9Nr4Ut2LxA8kVq6M';
export const SECOND = 'aud_3Hc6Wd1FzY5gBe0J';
export const ACTOR = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
export const OTHER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b02';
export const TARGET = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02';
export const NOW = '2026-10-20T02:00:00Z';
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };
export const OWN: PermissionSnapshot = { isSuper: false, permissions: [] };
export const EXPORTER: PermissionSnapshot = { isSuper: false, permissions: ['export'] };
export type AuditRow = Schema<'AdminAuditLogListItem'>;
export type AuditDetail = Schema<'AdminAuditLog'>;
export type ExportRow = Schema<'AdminExport'>;
export type ExportStatus = Schema<'AdminExportStatus'>;
export const DETAIL = `${LOGS}/${AID}`;

export const RECORD: AuditRow = {
  id: AID,
  actor_id: ACTOR,
  actor_name: '运营甲',
  action: 'user_risk_ban',
  target_type: 'user',
  target_id: TARGET,
  permission: 'risk.ban',
  ip: '203.0.113.8',
  at: '2026-10-18T17:05:06Z',
};
export const LEGACY: AuditRow = {
  ...RECORD,
  id: SECOND,
  actor_id: OTHER,
  actor_name: null,
  action: 'login',
  target_type: null,
  target_id: null,
  permission: null,
  ip: null,
  at: '2026-10-18T01:00:03Z',
};
export function detail(patch: Partial<AuditDetail> = {}): AuditDetail {
  return {
    ...RECORD,
    before: { state: 'normal', phone: '138****5678', enabled: false, count: 0 },
    after: { state: 'banned', phone: '138****5678', enabled: true, count: 0 },
    ...patch,
  };
}
export const DONE = 'exp_Wb6Hn2Lc9Pq4Sv8T';
export const FAILED = 'exp_Ra4Fz9Ux2Nh6Qc1B';
export const EXPIRED_DONE = 'exp_Pa8Zx4Uv9Mq6As2C';
export function exportRow(
  id = DONE,
  status: ExportStatus = 'done',
  patch: Partial<ExportRow> = {},
): ExportRow {
  return {
    id,
    resource: 'audit_logs',
    filters_summary: `审计记录 ${id}`,
    masked: true,
    created_by: ACTOR,
    created_by_name: '运营甲',
    created_at: '2026-10-19T01:20:00Z',
    status,
    progress: status === 'running' ? 35 : null,
    failure_reason: status === 'failed' ? '超过导出行数上限，请缩小筛选范围' : null,
    file_name: status === 'done' || status === 'expired' ? 'audit-logs.csv' : null,
    row_count: status === 'done' || status === 'expired' ? 12 : null,
    expires_at:
      status === 'done'
        ? '2026-10-21T02:00:00Z'
        : status === 'expired'
          ? '2026-10-19T02:00:00Z'
          : null,
    ...patch,
  };
}
export function exportRows(): ExportRow[] {
  return [
    exportRow(),
    exportRow(FAILED, 'failed'),
    exportRow('exp_Pn3Qw8Rt5Ym1Zx7N', 'pending'),
    exportRow('exp_Rn3Qw8Rt5Ym1Zx7N', 'running', { resource: 'users' }),
    exportRow('exp_Ex3Qw8Rt5Ym1Zx7N', 'expired'),
    exportRow('exp_Ca3Qw8Rt5Ym1Zx7N', 'cancelled'),
    exportRow(EXPIRED_DONE, 'done', { expires_at: NOW }),
  ];
}
export function manyLogs(): AuditRow[] {
  return Array.from({ length: 205 }, (_, index) => ({
    ...RECORD,
    id: index === 0 ? AID : `aud_${String(index).padStart(16, '0')}`,
  }));
}

type Reply = (request: RequestLog) => Response | Promise<Response>;
/**
 * HTTP-only fixture. Visibility is supplied by the test as an already scoped response;
 * this fixture does not pretend to prove server authorization. No production page helpers.
 */
export function createServer(logRows: AuditRow[] = [RECORD, LEGACY], tasks = exportRows()) {
  const state = {
    logs: structuredClone(logRows),
    tasks: structuredClone(tasks),
    detail: detail(),
  };
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let pending = 0;
  let signed = 0;
  function normal(request: RequestLog): Response {
    const { method, path, query } = request;
    if (method === 'GET' && (path === LOGS || path === EXPORTS)) {
      const page = Number(query['page'] ?? 1);
      const size = Number(query['page_size'] ?? 20);
      const items =
        path === LOGS
          ? state.logs.filter((row) =>
              ['actor_id', 'target_type', 'target_id', 'permission'].every(
                (key) => query[key] === undefined || row[key as keyof AuditRow] === query[key],
              ),
            )
          : state.tasks.filter(
              (row) =>
                (query['status'] === undefined || row.status === query['status']) &&
                (query['resource'] === undefined || row.resource === query['resource']),
            );
      const filtered = items.filter((row) => {
        const time = Date.parse('at' in row ? row.at : row.created_at);
        return (
          (query['from'] === undefined || time >= Date.parse(query['from'])) &&
          (query['to'] === undefined || time < Date.parse(query['to']))
        );
      });
      return ok({
        items: filtered.slice((page - 1) * size, page * size),
        page,
        page_size: size,
        total: filtered.length,
      });
    }
    if (method === 'GET' && path === DETAIL) return ok(state.detail);
    if (method === 'POST' && path === EXPORTS) {
      const task = exportRow('exp_NewQw8Rt5Ym1Zx7N', 'pending');
      state.tasks.unshift(task);
      const response = ok(task);
      return new Response(response.body, { status: 202, headers: response.headers });
    }
    const task = state.tasks.find((row) => path.startsWith(`${EXPORTS}/${row.id}/`));
    if (method === 'GET' && task && path.endsWith('/download')) {
      signed += 1;
      const response = ok({
        url: `https://exports.example.test/audit.csv?signature=synthetic-${signed}`,
        url_expires_at: '2026-10-20T02:05:00Z',
      });
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
    if (method === 'POST' && task && path.endsWith('/retry')) {
      task.status = 'pending';
      task.failure_reason = null;
      task.progress = null;
      return ok(task);
    }
    return failure(20001, { fields: ['id'] });
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
    requests(method: string, path: string) {
      return log.filter((request) => request.method === method && request.path === path);
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
