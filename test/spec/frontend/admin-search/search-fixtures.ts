import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { RequestLog } from '../admin-kill-switches/fixtures.ts';
import { createServer as dashboardServer } from '../admin-dashboard/dashboard-fixtures.ts';
import {
  BASE_URL,
  UID,
  createServer as usersServer,
  ok,
  failure,
} from '../admin-users/fixtures.ts';

export { BASE_URL, UID, ok, failure };
export const SEARCH = '/admin/v1/search';
export const PLACEHOLDER = '订单号 / 提现单号 / 手机号 / UID';
export const FOOTER =
  '按形状识别：订单号 / 提现单号 / 完整 11 位手机号 / UID（04 §6.6 search）。结果按 user.lookup、order.view、fund.view 裁剪；按手机号命中会写操作日志（同 user.lookup）。';
export const NO_HIT_FOOTER = '手机号须输入完整 11 位；订单号、提现单号、UID 按完整值匹配。';
export const ORDER_NUMBER = '3876512094471023';
export const WITHDRAWAL_NUMBER = 'W2026101100098';
export const UNKNOWN_NUMBER = 'W2026109900001';
export type Hit = Schema<'AdminSearchItem'>;
export type Result = Schema<'AdminSearch'>;
export const ORDER: Hit = {
  type: 'order',
  id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01',
  summary: '淘宝 订单 3876512094471023 · 已付款',
};
export const USER: Hit = {
  type: 'user',
  id: UID,
  summary: '凑狸用户5678 · 138****5678',
};
export const WITHDRAWAL: Hit = {
  type: 'withdrawal',
  id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f7a01',
  summary: 'W2026101100098 · 30.00 元 · 打款中 · 结果待确认',
};
export const LABELS = { order: '订单', user: '用户', withdrawal: '提现单' };
export const EMPTY: Result = { items: [], truncated: false };

type Reply = (request: RequestLog) => Response | Promise<Response>;

/**
 * This is a transport fixture, not an implementation of server matching/permissions.
 * Each test supplies the already-trimmed contract response; real data-provider serialization,
 * error mapping and user-detail requests still run. Other pages reuse their frozen fixtures.
 */
export function createServer(initial: Result = { items: [ORDER, USER], truncated: false }) {
  const users = usersServer();
  const dashboard = dashboardServer();
  const log: RequestLog[] = [];
  const overrides: Reply[] = [];
  let pending = 0;
  const result = structuredClone(initial);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== SEARCH) {
      return url.pathname === '/admin/v1/dashboard'
        ? dashboard.fetch(input, init)
        : users.fetch(input, init);
    }
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
      return await (overrides.shift()?.(request) ?? ok(result));
    } finally {
      pending -= 1;
    }
  };
  return {
    fetch,
    log,
    users,
    result,
    get pending() {
      return pending + users.pending + dashboard.pending;
    },
    once(reply: Reply) {
      overrides.push(reply);
    },
    hold() {
      const gate = Promise.withResolvers<void>();
      overrides.push(async () => {
        await gate.promise;
        return ok(result);
      });
      return gate.resolve;
    },
  };
}
export type Server = ReturnType<typeof createServer>;
