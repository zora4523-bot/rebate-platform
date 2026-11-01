import type { BridgeMethods, H5Token } from '@couli/bridge-sdk';
import { createAppApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };
import { installBridge } from '../bridge-sdk/kit.ts';
import { reply } from '../h5-notices/fixtures.ts';

export { reply } from '../h5-notices/fixtures.ts';
export type InboxMessage = components['schemas']['InboxMessage'];

/** 契约字典里本页用到的文案（任务书 §9.3 ⑥：messages.* 取字典，加载失败 h5.load_failed、离线 error.50001）。 */
export const texts = {
  empty: dictionary.texts['messages.empty'],
  emptyHint: dictionary.texts['messages.empty_hint'],
  readAll: dictionary.texts['messages.read_all'],
  unread: dictionary.texts['messages.unread'],
  loadFailed: dictionary.texts['h5.load_failed'],
  // 表 A 的 error.50001 带 {trace6}；离线态只核对占位符之前的句子（包内默认同句）。
  offline: dictionary.fallbacks['error.50001'],
};

/** 标已读失败时不得出现的错误文案（任务书 §9.3 ⑤：不弹错）。 */
export const markReadErrors = {
  10403: dictionary.texts['error.10403.h5_read_only'],
  10405: dictionary.texts['error.10405'],
  20001: dictionary.texts['error.20001'],
  50001: dictionary.fallbacks['error.50001'],
} as const;

/** 注销冷静期内 POST /v1/messages/read 的回包文案（不得出现在页面上，编排裁定 D10-542）。 */
export const coolingError = dictionary.texts['error.10007'];

/** 编排裁定 D10-542：冷静期内标已读不在 10007 白名单，服务端回 10007（data.stage=cooling）。 */
export function coolingOff(): Response {
  return reply({ stage: 'cooling' }, 10007, 403);
}

export const orderId = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a91';

// 当前时刻固定为 2026-10-22T12:00:00+08:00（messages-helpers.ts）；时间按 BR-TEXT-11 细则（Asia/Shanghai）。
/** 未读、可点（OrderDetail），今天 09:05。 */
export const tracked: InboxMessage = {
  message_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01',
  code: 'ORDER_TRACKED',
  title: '跟单成功',
  body: '你在淘宝下的订单已跟单，预估返利 ¥6.01',
  created_at: '2026-10-22T09:05:33+08:00',
  read_at: null,
  route: { route: 'OrderDetail', params: { order_id: orderId } },
};

/** 已读、可点（WithdrawRecords，参数为空），昨天 23:59。 */
export const paid: InboxMessage = {
  message_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b02',
  code: 'WD_SUCCESS',
  title: '提现到账',
  body: '你申请的提现 ¥98.76 已到账',
  created_at: '2026-10-21T23:59:00+08:00',
  read_at: '2026-10-22T08:00:00+08:00',
  route: { route: 'WithdrawRecords', params: {} },
};

/** 未读、没有 route（不可点），同年更早：09-27。 */
export const risk: InboxMessage = {
  message_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b03',
  code: 'RISK_STATE_CHANGED',
  title: '账号状态',
  body: '你的账号已恢复正常，提现功能已恢复',
  created_at: '2026-09-27T14:03:00+08:00',
  read_at: null,
  route: null,
};

/** 已读、可点（DeleteAccount），跨年：2025-12-31。 */
export const deletion: InboxMessage = {
  message_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b04',
  code: 'DELETION_PROGRESS',
  title: '注销进度',
  body: '你已撤回注销申请，账号恢复正常使用',
  created_at: '2025-12-31T08:00:00+08:00',
  read_at: '2026-01-01T09:00:00+08:00',
  route: { route: 'DeleteAccount' },
};

export const messages: InboxMessage[] = [tracked, paid, risk, deletion];

let serial = 0x100;
/** 另造一条消息（新的 message_id）；默认未读、可点。 */
export function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  serial += 1;
  return {
    message_id: `0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f${serial.toString(16).padStart(4, '0')}`,
    code: 'ORDER_TRACKED',
    title: '跟单成功',
    body: '订单已跟单',
    created_at: '2026-10-22T08:00:00+08:00',
    read_at: null,
    route: { route: 'OrderDetail', params: { order_id: orderId } },
    ...overrides,
  };
}

export function list(
  items: InboxMessage[] = messages,
  next_cursor: string | null = null,
): components['schemas']['InboxMessageListData'] {
  return { items, next_cursor };
}

const nativeEnv: BridgeMethods['app.getEnv']['result'] = {
  platform: 'android',
  app_version: '2.4.6',
  build: '2468',
  channel: 'official',
  os_version: '15',
  bridge_version: 1,
  safe_area: { top: 0, right: 0, bottom: 0, left: 0 },
};

type Handler<A extends unknown[]> = (...args: A) => Response | Promise<Response>;

export interface MessagesHandlers {
  /** GET /v1/messages；count 为第几次列表请求（从 1 起）。 */
  list?: Handler<[url: URL, count: number]>;
  /** POST /v1/messages/read；body 为解析后的请求体。 */
  read?: Handler<[body: unknown, count: number]>;
}

/** Real app API + SDK token manager; only native and HTTP boundaries are fake. */
export function messagesServer(
  handlers: MessagesHandlers = {},
  options: { scope?: H5Token['scope'] } = {},
) {
  let tokens = 0;
  const requests: Request[] = [];
  const reads: unknown[] = [];
  let lists = 0;
  const native = installBridge(['app.getEnv', 'auth.getH5Token', 'nav.open'], (request) => {
    if (request.method === 'app.getEnv')
      return { id: request.id, code: 0, msg: '', data: nativeEnv };
    if (request.method === 'auth.getH5Token') {
      tokens += 1;
      return {
        id: request.id,
        code: 0,
        msg: '',
        data: {
          token: `messages-token-${tokens}`,
          scope: options.scope ?? 'standard',
          expire_at: '2099-01-01T00:00:00Z',
        },
      };
    }
    return { id: request.id, code: 0, msg: '', data: { opened: true } };
  });
  const onList: NonNullable<MessagesHandlers['list']> = handlers.list ?? (() => reply(list()));
  const onRead: NonNullable<MessagesHandlers['read']> =
    handlers.read ?? (() => reply({ marked_count: 1, unread_count: 0 }));
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/messages') {
      lists += 1;
      return onList(url, lists);
    }
    if (request.method === 'POST' && url.pathname === '/v1/messages/read') {
      const body: unknown = JSON.parse(await request.text());
      reads.push(body);
      return onRead(body, reads.length);
    }
    return reply(null, 30701, 404);
  };
  const api = createAppApi({
    env: { apiBaseUrl: 'https://api.example.invalid', appId: 'fixture_brand' },
    fetch,
  });
  const byPath = (method: string, pathname: string) =>
    requests.filter(
      (request) => request.method === method && new URL(request.url).pathname === pathname,
    );
  return {
    api,
    requests,
    /** 解析后的 POST /v1/messages/read 请求体，按发出顺序。 */
    reads,
    listRequests: () => byPath('GET', '/v1/messages'),
    readRequests: () => byPath('POST', '/v1/messages/read'),
    /** H5 令牌无权读注销状态（BR-ID-32，D10-542）：页面不得请求它，只用来断言从未调用。 */
    deletionRequests: () => byPath('GET', '/v1/me/deletion'),
    tokenCalls: () => tokens,
    navigation: () =>
      native.postMessage.mock.calls
        .map(([request]) => request)
        .filter((request) => request.method === 'nav.open'),
    bridgeCalls: () => native.postMessage.mock.calls.map(([request]) => request.method),
  };
}
