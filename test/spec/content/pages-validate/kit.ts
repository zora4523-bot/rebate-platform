import type { PageValidationContext } from '../../../../apps/api/src/modules/content/domain/pages/validate/index.ts';

// F1-09c §9.2 裁定；全部为合成数据，不代表真实平台录制或可用频道。
export function context(overrides: Partial<PageValidationContext> = {}): PageValidationContext {
  return {
    unionHostBlock: true,
    routeNames: new Set([
      'ExternalPage',
      'Withdraw',
      'PayoutAccount',
      'LaborAgreement',
      'RealName',
      'Help',
      'Notice',
    ]),
    linkPatterns: {
      version: 't',
      rules: [
        {
          platform: 'taobao',
          category: 'union_host',
          hosts: ['union-a.test', 'union-b.test'],
          path_patterns: [],
        },
        {
          platform: 'jd',
          category: 'union_host',
          hosts: ['union-c.test'],
          path_patterns: [],
        },
      ],
    },
    materialChannels: {
      version: 't',
      channels: [
        {
          platform: 'taobao',
          channel_id: 'sales_a',
          name: '合成销量频道',
          sort_basis: 'sales',
          selectable: true,
          source: 'synthetic fixture',
        },
        {
          platform: 'jd',
          channel_id: 'popular_b',
          name: '合成热度频道',
          sort_basis: 'popularity',
          selectable: true,
          source: 'synthetic fixture',
        },
        {
          platform: 'jd',
          channel_id: 'sales_a',
          name: '合成不可选频道',
          sort_basis: 'sales',
          selectable: false,
          source: 'synthetic fixture',
        },
      ],
    },
    ...overrides,
  };
}

export function withAction(action: unknown): unknown[] {
  return [{ type: 'banner', data_source: { kind: 'static', items: [{ action }] } }];
}

export function withUrl(url: unknown): unknown[] {
  return withAction({ route: 'ExternalPage', params: { url } });
}

export const ACTION_PATH = 'sections.0.data_source.items.0.action';
export const URL_PATH = `${ACTION_PATH}.params.url`;
