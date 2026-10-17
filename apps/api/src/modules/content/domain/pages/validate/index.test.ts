import { describe, expect, it } from 'vitest';
import { validatePageSections, type PageValidationContext } from './index.ts';

const CTX: PageValidationContext = {
  unionHostBlock: true,
  routeNames: new Set(['ExternalPage', 'Withdraw', 'Help']),
  linkPatterns: {
    version: 'u',
    rules: [{ platform: 'p', category: 'union_host', hosts: ['union.test'], path_patterns: [] }],
  },
  materialChannels: {
    version: 'u',
    channels: [
      {
        platform: 'p',
        channel_id: 'c1',
        name: 'n',
        sort_basis: 'sales',
        selectable: true,
        source: 's',
      },
    ],
  },
};

describe('validatePageSections', () => {
  it('[AC-F1-09c] collects every violation in traversal order without duplicates', () => {
    const sections = [
      {
        type: 'banner',
        data_source: { kind: 'api' },
        props: {
          a: { route: 'ExternalPage', params: { url: 'https://union.test/{uid}' } },
          b: { route: 'Withdraw', params: { x: 1 } },
        },
      },
      {
        type: 'product_grid',
        data_source: { kind: 'union_material', channels: [{ platform: 'p', channel_id: 'c1' }] },
      },
    ];
    expect(validatePageSections(sections, CTX)).toStrictEqual([
      'sections.0.data_source',
      'sections.0.props.a.params.url',
      'sections.0.props.b.params',
    ]);
  });

  it('[AC-F1-09c] union host passes when the switch is off; invalid url still fails', () => {
    const off = { ...CTX, unionHostBlock: false };
    const target = (url: unknown): unknown[] => [
      { props: { route: 'ExternalPage', params: { url } } },
    ];
    expect(validatePageSections(target('https://union.test/'), off)).toStrictEqual([]);
    expect(validatePageSections(target('http://brand.test/'), off)).toStrictEqual([
      'sections.0.props.params.url',
    ]);
  });

  it('[AC-F1-09c] tolerates cyclic input and non-array sections', () => {
    const node: Record<string, unknown> = { route: 'Help' };
    node['self'] = node;
    expect(validatePageSections([node], CTX)).toStrictEqual([]);
    expect(validatePageSections({}, CTX)).toStrictEqual(['sections']);
  });

  it('[AC-F1-09c] data_source checks apply only to the section level', () => {
    const sections = [{ type: 'banner', props: { data_source: { kind: 'api' } } }];
    expect(validatePageSections(sections, CTX)).toStrictEqual([]);
  });
});
