import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { createApiClient } from '../../../../apps/h5/src/shared/api/index.ts';

export const CDN = 'https://media.example.invalid';
export const BODY_TEXT = '你通过凑狸的链接下单，平台会按订单支付推广费用。';

export function text(value: string) {
  return { type: 'text', text: value };
}

export function paragraph(value: string) {
  return { type: 'paragraph', content: [text(value)] };
}

export function doc(...content: unknown[]): string {
  return JSON.stringify({ type: 'doc', content });
}

export const articles: components['schemas']['Article'][] = [
  {
    article_id: 'z-rebate',
    category: 'rule',
    title: '返利规则',
    version: 3,
    // Beijing date differs from both UTC and the date written in this ISO string.
    published_at: '2026-09-30T17:30:00Z',
    body: doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('一、返利从哪里来')] },
      paragraph(BODY_TEXT),
      { type: 'heading', attrs: { level: 2 }, content: [text('二、怎样拿到返利')] },
      {
        type: 'orderedList',
        content: ['搜索商品或粘贴链接查返利。', '点击去购买，在平台商品页下单。'].map((value) => ({
          type: 'listItem',
          content: [paragraph(value)],
        })),
      },
      { type: 'heading', attrs: { level: 2 }, content: [text('三、返利的几个阶段')] },
      paragraph('结算前的金额都叫「预估」，以结算为准。'),
      { type: 'blockquote', content: [paragraph('确认收货后随联盟月度结算入账。')] },
      { type: 'heading', attrs: { level: 2 }, content: [text('四、返利会变少或取消的情况')] },
      paragraph('订单退款或取消时，返利会相应减少或取消。'),
      { type: 'heading', attrs: { level: 2 }, content: [text('五、订单页没有显示怎么办')] },
      paragraph('提交订单号和付款日期，客服核对后处理。'),
      { type: 'heading', attrs: { level: 2 }, content: [text('六、提现')] },
      paragraph('已结算的金额可以提现，具体方式见提现规则。'),
    ),
  },
  {
    article_id: 'a-withdrawal',
    category: 'rule',
    title: '提现规则',
    version: 2,
    published_at: '2026-10-02T00:30:00+08:00',
    body: doc(paragraph('提现规则正文。')),
  },
  {
    article_id: 'm-recovery',
    category: 'rule',
    title: '订单找回',
    version: 1,
    published_at: '2026-10-03T00:30:00+08:00',
    body: doc(paragraph('订单找回正文。')),
  },
];

export function summaries(items = articles): components['schemas']['ArticleListData'] {
  return {
    items: items.map(({ article_id, category, title, version, published_at }) => ({
      article_id,
      category: category as 'rule',
      title,
      version,
      published_at,
    })),
    next_cursor: null,
  };
}

export function reply(data: unknown, code = 0, status = 200): Response {
  return new Response(JSON.stringify({ code, msg: '', data, trace_id: 'rules-fixture' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Real H5 API adapter, fake HTTP boundary; never opens a socket. */
export function server(
  handler: (url: URL, count: number) => Response | Promise<Response> = (url) => {
    if (url.pathname === '/v1/articles') return reply(summaries());
    const article = articles.find((item) => url.pathname === `/v1/articles/${item.article_id}`);
    return article ? reply(article) : reply(null, 30701, 404);
  },
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
