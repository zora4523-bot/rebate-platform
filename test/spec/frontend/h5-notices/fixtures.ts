import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { createApiClient } from '../../../../apps/h5/src/shared/api/index.ts';

export type Article = components['schemas']['Article'];
export const NOTICE_BODY = '维护期间订单可能延迟显示，维护结束后会自动补上。';
export const AGREEMENT_BODY = '请阅读本协议，了解服务内容与个人信息处理方式。';
export const CDN = 'https://media.example.invalid';

export function body(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
}

// Server order deliberately puts the older notice first; clients must not sort by date.
export const notices: components['schemas']['NoticeArticleSummary'][] = [
  {
    article_id: 'z-maintenance',
    category: 'notice',
    title: '订单同步维护通知',
    version: 3,
    published_at: '2026-09-28T16:15:00Z',
    notice: {
      item_id: 'z-maintenance',
      content_version: 1,
      text: '订单维护时间已经确定，请查看正文了解详细安排。',
      target: null,
      closable: true,
      start_at: '2026-09-28T16:15:00Z',
      end_at: null,
    },
  },
  {
    article_id: 'a-service',
    category: 'notice',
    title: '国庆期间客服时间调整',
    version: 1,
    published_at: '2026-09-30T17:30:00Z',
    notice: {
      item_id: 'a-service',
      content_version: 2,
      text: '国庆期间客服在线时间有调整，具体时间见公告正文。',
      target: null,
      closable: true,
      start_at: '2026-09-30T17:30:00Z',
      end_at: null,
    },
  },
];

export const noticeArticle: Article = {
  article_id: notices[0]!.article_id,
  category: 'notice',
  title: notices[0]!.title,
  version: 3,
  published_at: notices[0]!.published_at,
  body: body(NOTICE_BODY),
};

export const agreements: Article[] = [
  { article_id: 'agreement', title: '凑狸用户协议' },
  { article_id: 'privacy', title: '凑狸隐私政策' },
  { article_id: 'sdk_list', title: '第三方 SDK 清单' },
].map((item) => ({
  ...item,
  category: 'agreement',
  version: 7,
  published_at: '2026-09-30T17:30:00Z',
  body: body(AGREEMENT_BODY),
}));

export function list(
  items = notices,
  next_cursor: string | null = null,
): components['schemas']['ArticleListData'] {
  return { items, next_cursor };
}

export function reply(data: unknown, code = 0, status = 200): Response {
  return new Response(JSON.stringify({ code, msg: '', data, trace_id: 'notices-fixture' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function defaultReply(url: URL): Response {
  if (url.pathname === '/v1/articles') return reply(list());
  const id = decodeURIComponent(url.pathname.slice('/v1/articles/'.length));
  const agreement = agreements.find((item) => item.article_id === id);
  if (agreement) return reply(agreement);
  const notice = notices.find((item) => item.article_id === id);
  return notice
    ? reply({ ...noticeArticle, article_id: id, title: notice.title })
    : reply(null, 30701, 404);
}

/** Real API client with a fake fetch boundary: no network or listening socket. */
export function server(
  handler: (url: URL, count: number) => Response | Promise<Response> = defaultReply,
) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    return handler(new URL(request.url), requests.length);
  };
  const api = createApiClient({
    baseUrl: 'https://api.example.invalid',
    headers: () => ({ 'X-App-Id': 'fixture_brand', 'X-Platform': 'h5', 'X-App-Version': '1.0.0' }),
    fetch,
  });
  return { api, requests, fetch };
}

export function urls(requests: Request[]): string[] {
  return requests.map((request) => {
    const url = new URL(request.url);
    return url.pathname + url.search;
  });
}
