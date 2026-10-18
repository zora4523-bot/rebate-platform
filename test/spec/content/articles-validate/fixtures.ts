import type {
  ArticleSaveContext,
  ArticleSaveInput,
} from '../../../../apps/api/src/modules/content/domain/articles-admin/index.ts';

// Synthetic caller-supplied tables, independent of production platform records and word lists.
export function context(overrides: Partial<ArticleSaveContext> = {}): ArticleSaveContext {
  return {
    mediaHosts: ['media.example.test'],
    unionHostBlock: true,
    linkPatterns: {
      version: 'test',
      rules: [
        {
          platform: 'demo',
          category: 'union_host',
          hosts: ['union.example.test'],
          path_patterns: [],
        },
        { platform: 'demo', category: 'product', hosts: ['shop.example.test'], path_patterns: [] },
      ],
    },
    bannedWords: [
      { word: '全网最低', category: 'test', scopes: ['user_visible'] },
      {
        word: '比价',
        category: 'test',
        scopes: ['user_visible'],
        allow_articles: [{ config_key: 'help_links.price_compare', fields: ['body'] }],
      },
      { word: '后台专词', category: 'test', scopes: ['admin_report'] },
    ],
    articleConfigKeys: [],
    ...overrides,
  };
}

export function documentBody(...nodes: unknown[]): string {
  return JSON.stringify({ type: 'doc', content: nodes });
}

export function textNode(text: string, marks: readonly unknown[] = []): unknown {
  return { type: 'text', text, marks };
}

export function paragraph(...nodes: unknown[]): unknown {
  return { type: 'paragraph', content: nodes };
}

export function linkedText(href: string): unknown {
  return textNode('查看详情', [{ type: 'link', attrs: { href } }]);
}

export function article(overrides: Partial<ArticleSaveInput> = {}): ArticleSaveInput {
  return {
    category: 'help',
    title: '使用帮助',
    body: documentBody(paragraph(textNode('使用说明'))),
    notice_closable: true,
    notice_end_at: null,
    ...overrides,
  };
}
