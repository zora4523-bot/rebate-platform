import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { BASE_URL, ok, failure } from '../admin-users/fixtures.ts';

export { BASE_URL, ok, failure };
export const ENDPOINT = '/admin/v1/dashboard';
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };
export const FINANCE: PermissionSnapshot = {
  isSuper: false,
  permissions: [
    'dashboard.view',
    'withdraw.review',
    'payout.execute',
    'settle.bill',
    'fund.recon',
    'fund.adjust',
    'fund.cash_entry',
    'fund.view',
  ],
};
export type Dashboard = Schema<'AdminDashboard'>;
// Independent labels from the approved boards; routes are synthetic contract-shaped responses.
// Deep routes in the contract must survive navigation, even when only a placeholder exists.
export const CARDS = [
  ['withdraw_review_pending', '待审提现', '提现审核', '/withdrawals?status=pending'],
  ['claim_review_pending', '待审找回', '找回审核', '/orders/claims?status=pending'],
  ['settle_bill_pending', '待确认月结账单', '月结账单', '/settle-bills?status=pending'],
  ['recon_diff_open', '未关闭差错单', '对账与差错', '/recon?status=open'],
  ['appeal_pending', '待处理申诉', '风控 · 申诉', '/risk/appeals?status=pending'],
  ['agent_report_overdue', 'AI 举报超 48 小时', 'AI 助手记录', '/agent/reports?overdue=true'],
  ['beneficiary_held_overdue', '受益人份额 held 满 30 天', '风控 · held 告警', '/risk/held-alerts'],
  ['union_auth_expiring', '站长授权到期或失效', '联盟账号', '/union/accounts?auth=expiring'],
] as const;

export function dashboard(): Dashboard {
  return {
    todo: CARDS.map(([key, , , route], index) => ({
      key,
      count: [12, 35, 1, 3, 2, 1, 1, 2][index]!,
      route,
      ...(index === 0 ? { oldest_at: '2026-10-11T08:20:00Z' } : {}),
      ...(index === 1
        ? {
            breakdown: [
              { key: 'auto_matched', count: 12 },
              { key: 'manual_review', count: 23 },
            ],
          }
        : {}),
    })),
    yesterday: {
      date: '2026-10-11',
      links: 1780,
      orders: 268,
      est_rebate_fen: 123640,
      new_users: 96,
      as_of: '2026-10-11T22:00:00Z',
    },
    status: {
      payout_queue_paused: false,
      payout_channel_paused: [],
      settle_auto_enabled: true,
      balance_w_expired: null,
    },
  };
}
export function financeDashboard(): Dashboard {
  const data = dashboard();
  const { todo: items } = data;
  return {
    ...data,
    todo: items.filter(({ key }) =>
      ['withdraw_review_pending', 'settle_bill_pending', 'recon_diff_open'].includes(key),
    ),
  };
}

type Reply = () => Response | Promise<Response>;
export function createServer(initial = dashboard()) {
  const state = structuredClone(initial);
  const log: { method: string; path: string; search: string; headers: Headers }[] = [];
  const replies: Reply[] = [];
  let pending = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    log.push({
      method,
      path: url.pathname,
      search: url.search,
      headers: new Headers(init?.headers),
    });
    pending += 1;
    try {
      if (method !== 'GET' || url.pathname !== ENDPOINT)
        return failure(20001, { fields: ['path'] });
      return await (replies.shift()?.() ?? ok(state));
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
    once(reply: Reply) {
      replies.push(reply);
    },
    hold() {
      const gate = Promise.withResolvers<void>();
      replies.push(async () => {
        await gate.promise;
        return ok(state);
      });
      return gate.resolve;
    },
  };
}
export type Server = ReturnType<typeof createServer>;
