import { vi } from 'vitest';
import { createH5TokenManager, type Capability, type BridgeMethodName } from '@couli/bridge-sdk';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { createAppApi, type AppApiBridge } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { doc, paragraph, text, reply, server } from '../h5-rules/fixtures.ts';

export { doc, paragraph, text, reply } from '../h5-rules/fixtures.ts';
export const BODY_TEXT = '这段内容由帮助文章接口提供，页面不维护答案。';
export const BODY_HEADING = '后台发布的说明';
// Content fixtures, not approved business answers. Deliberately not sorted by ID or title.
export const articles: components['schemas']['Article'][] = [
  {
    article_id: 'z-faq-47',
    category: 'help',
    title: '为什么看不到我邀请的好友买了什么？',
    version: 3,
    published_at: '2026-10-04T16:30:00Z',
    body: doc(
      { type: 'heading', attrs: { level: 2 }, content: [text(BODY_HEADING)] },
      paragraph(BODY_TEXT),
      {
        type: 'orderedList',
        content: [
          { type: 'listItem', content: [paragraph('先阅读这条说明。')] },
          { type: 'listItem', content: [paragraph('仍有疑问可以联系客服。')] },
        ],
      },
    ),
  },
  {
    article_id: 'a-faq-82',
    category: 'help',
    title: '邀请带来的收益在哪里看？',
    version: 1,
    published_at: '2026-10-03T08:00:00Z',
    body: doc(paragraph('第二篇后台内容。')),
  },
  {
    article_id: 'm-faq-19',
    category: 'help',
    title: '订单里的「分享」是什么？',
    version: 2,
    published_at: '2026-10-02T08:00:00Z',
    body: doc(paragraph('第三篇后台内容。')),
  },
];

export function summaries(
  items = articles,
  nextCursor: string | null = null,
): components['schemas']['ArticleListData'] {
  return {
    items: items.map(({ article_id, title, version, published_at }) => ({
      article_id,
      category: 'help',
      title,
      version,
      published_at,
    })),
    next_cursor: nextCursor,
  };
}

export function helpServer(
  handler: Parameters<typeof server>[0] = (url) => {
    if (url.pathname === '/v1/articles') return reply(summaries());
    const article = articles.find((item) => url.pathname === `/v1/articles/${item.article_id}`);
    return article ? reply(article) : reply(null, 30701, 404);
  },
) {
  return server(handler);
}

/** Opaque handles are confined to this fake facade; never passed to the real SDK call(). */
export function fakeBridge(options: { inApp?: boolean; support?: boolean; opened?: boolean } = {}) {
  const supportHandle = { method: 'cs.open' } as Capability<'cs.open'>;
  const envHandle = { method: 'app.getEnv' } as Capability<'app.getEnv'>;
  const has = vi.fn((method: BridgeMethodName) => {
    if (method === 'cs.open' && options.support !== false) return supportHandle;
    if (method === 'app.getEnv') return envHandle;
    return null;
  });
  const call = vi.fn(async (handle: { method: string }, _params: unknown) => {
    void _params;
    if (handle === supportHandle) return { opened: options.opened !== false };
    if (handle === envHandle)
      return {
        platform: 'android',
        app_version: '1.0.0',
        build: '100',
        channel: 'official',
        os_version: '15',
        bridge_version: 1,
        safe_area: { top: 0, right: 0, bottom: 0, left: 0 },
      };
    throw new Error(`Unexpected fake bridge call: ${handle.method}`);
  });
  const manager = createH5TokenManager();
  const getToken = vi.spyOn(manager, 'getToken');
  const authenticatedRequest = vi.spyOn(manager, 'request');
  const bridge: AppApiBridge = {
    isInApp: vi.fn(() => options.inApp !== false),
    has: has as AppApiBridge['has'],
    call: call as AppApiBridge['call'],
    createH5TokenManager: () => manager,
  };
  return { bridge, has, call, supportHandle, getToken, authenticatedRequest };
}

export function appApi(http: ReturnType<typeof helpServer>, native: ReturnType<typeof fakeBridge>) {
  return createAppApi({
    bridge: native.bridge,
    fetch: http.fetch,
    env: { apiBaseUrl: 'https://api.example.invalid', appId: 'fixture_brand' },
  });
}
