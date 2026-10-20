import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.admin.default.json' with { type: 'json' };
import { BASE_URL, failure as baseFailure, ok } from '../admin-kill-switches/fixtures.ts';
import type { RequestLog } from '../admin-kill-switches/fixtures.ts';

export { BASE_URL, ok };
export function failure(
  code: number,
  data: unknown = null,
  msg = code === 20001 ? '参数错误' : '操作失败',
): Response {
  const response = baseFailure(code, data, msg);
  return code === 20902
    ? new Response(response.body, { status: 409, headers: response.headers })
    : response;
}
export type Claim = Schema<'AdminClaimDetail'>;
export type Row = Schema<'AdminClaimListItem'>;
export type Item = Schema<'AdminClaimItem'>;
export const LIST = '/admin/v1/claims';
export const CID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5aa0';
export const UID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02';
export const DETAIL = `${LIST}/${CID}`;
export const ROUTE = `/claims/${CID}`;
export const REASON = '付款记录已核对';
export const PREFILL = '证据核实一致';
export const STAFF_REASONS: Schema<'AdminClaimStaffRejectReason'>[] = [
  'NO_EVIDENCE',
  'EXPIRED_CLICK',
  'NOT_TRACKED',
  'OTHER_TLJ',
  'FRAUD',
  'OTHER',
];
export const STATUSES: Schema<'ClaimStatus'>[] = [
  'submitted',
  'auto_matched',
  'manual_review',
  'approved',
  'rejected',
  'cancelled',
];
export function statusLabel(status: Schema<'ClaimStatus'>): string {
  return dictionary.texts[`admin_dict.claim_status.${status}`];
}
export function rejectLabel(reason: Schema<'ClaimRejectReason'>): string {
  return dictionary.texts[`admin_dict.claim_reject_reason.${reason}`];
}

/** Synthetic contract data only. The older auto_matched row intentionally leads the newer row. */
export function rows(): Row[] {
  return Array.from({ length: 205 }, (_, index) => ({
    claim_id:
      index === 1 ? CID : `0199a3b4-5c6d-7e8f-9a0b-${String(index + 100).padStart(12, '0')}`,
    order_no: `231005-${String(9000000000 + index)}`,
    platform: index === 1 ? 'pdd' : 'taobao',
    user: { user_id: UID, phone_masked: index === 2 ? null : '135****6021' },
    paid_date: '2026-10-05',
    submitted_at: index === 0 ? '2026-10-12T00:02:31Z' : '2026-10-12T01:15:00Z',
    evidence_level: index === 0 ? 'strong' : index === 1 ? 'weak' : 'none',
    status: index === 0 ? 'auto_matched' : 'manual_review',
  }));
}
export function detail(): Claim {
  return {
    ...rows()[1]!,
    reason: null,
    items: [0, 1].map((index): Item => ({
      item_id: `0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5ab${index + 1}`,
      sub_order_id: `231005-098765432${index + 2}`,
      evidence: index === 0 ? 'strong' : 'weak',
      decision: null,
      reject_reason: null,
      decided_at: null,
      decided_by: null,
      decided_by_name: null,
      row_version: index === 0 ? 7 : 11,
      matches: [
        {
          field: 'order_no',
          user_value: rows()[1]!.order_no,
          // PDD normalisation can match different display strings.
          union_value: index === 0 ? rows()[1]!.order_no.replace('-', '') : rows()[1]!.order_no,
          matched: true,
        },
        {
          field: 'paid_date',
          // Equal display strings deliberately carry a negative server verdict.
          // The console must render matched, never derive it from the strings.
          user_value: index === 0 ? '2026-10-05' : '2026-10-04',
          union_value: index === 0 ? '2026-10-05' : '2026-10-04',
          matched: index === 0,
        },
      ],
      evidence_links: [
        { at: '2026-10-05T10:58:12+08:00', scene: index === 0 ? 'detail' : 'home_card' },
      ],
    })),
  };
}
export function actionPath(index: number, action: 'approve' | 'reject'): string {
  return `${DETAIL}/items/${detail().items[index]!.item_id}/${action}`;
}
export function decided(item: Item, patch: Partial<Item> = {}): Item {
  return {
    ...item,
    decision: 'approved',
    decided_at: '2026-10-12T10:40:00+08:00',
    decided_by: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01',
    decided_by_name: '客服小林',
    row_version: item.row_version + 1,
    ...patch,
  };
}
type Reply = (request: RequestLog) => Response | Promise<Response>;

/** HTTP fake deliberately never decides attribution. Tests supply whole-claim write responses. */
export function createServer(initial = rows(), initialClaim = detail()) {
  const state = structuredClone(initial);
  const claim = structuredClone(initialClaim);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let pending = 0;
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
        Object.keys(query).some(
          (key) =>
            !['page', 'page_size', 'platform', 'evidence_level', 'status', 'user_id', 'q'].includes(
              key,
            ),
        )
      )
        return failure(20001, { fields: ['page_size'] });
      const q = query['q']?.replace(/\s/g, '');
      const filtered = state.filter(
        (row) =>
          (!query['platform'] || row.platform === query['platform']) &&
          (!query['evidence_level'] || row.evidence_level === query['evidence_level']) &&
          (!query['user_id'] || row.user.user_id === query['user_id']) &&
          (!q ||
            row.claim_id === q ||
            row.order_no === q ||
            (row.claim_id === claim.claim_id &&
              claim.items.some((item) => item.sub_order_id === q))),
      );
      const counts = Object.fromEntries(
        STATUSES.map((status) => [status, filtered.filter((row) => row.status === status).length]),
      );
      const items = filtered.filter((row) => !query['status'] || row.status === query['status']);
      return ok({
        items: items.slice((page - 1) * size, page * size),
        page,
        page_size: size,
        total: items.length,
        counts,
      });
    }
    if (method === 'GET' && path === DETAIL) return ok(claim);
    return failure(20001, { fields: [method === 'GET' ? 'claim_id' : 'unexpected_write'] });
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
    claim,
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
