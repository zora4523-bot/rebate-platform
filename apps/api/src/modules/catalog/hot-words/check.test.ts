import { expect, it, vi } from 'vitest';
import type { LinkPatternsSpec } from '../../platform/index.ts';
import { searchConfigSaveCheck, searchKeywordRoutesFit } from './check.ts';
import { readSearchHotWords } from './read.ts';
import { compileRouteTable } from './route-table.ts';

const PATTERNS: LinkPatternsSpec = {
  version: 'unit',
  rules: [{ platform: 'jd', category: 'union_host', hosts: ['union.test'], path_patterns: [] }],
};
const ON = { unionHostBlock: true, linkPatterns: PATTERNS };
const external = (url: string) => [
  { keyword: '官网', target: { route: 'ExternalPage', params: { url } } },
];

it('[AC-B1-05m] ExternalPage urls with user info or a blank keyword are refused', () => {
  expect(searchKeywordRoutesFit(external('https://brand.test/'), ON)).toBe(true);
  expect(searchKeywordRoutesFit(external('https://union.test@brand.test/'), ON)).toBe(false);
  expect(searchKeywordRoutesFit(external('https://u:p@brand.test/'), ON)).toBe(false);
  expect(searchKeywordRoutesFit([{ keyword: '  ', target: { route: 'Home' } }], ON)).toBe(false);
});

it('[AC-B1-05m] debug_only routes and names missing from the table do not fit', () => {
  const table = compileRouteTable({
    routes: {
      Open: {
        params: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      },
      Debug: {
        debug_only: true,
        params: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      },
    },
  });
  expect(table.fits('Open', undefined)).toBe(true);
  expect(table.fits('Debug', undefined)).toBe(false);
  expect(table.fits('constructor', undefined)).toBe(false);
  expect(() => compileRouteTable({})).toThrow(/routes required/);
});

it('[AC-B1-05m] the save check reads the switch from the write first, then the stored row', () => {
  const check = searchConfigSaveCheck(() => PATTERNS);
  const routes = external('https://m.union.test/a');
  const write = (value: unknown) => new Map([['search.keyword_routes', value]]);
  expect(check.refusals(new Map(), write(routes))).toEqual(['search.keyword_routes']);
  const off = new Map([['external_page.union_host_block', false]]);
  expect(check.refusals(off, write(routes))).toEqual([]);
  const both = new Map<string, unknown>([
    ['search.hot_words', [{ text: '' }]],
    ['search.keyword_routes', routes],
    ['external_page.union_host_block', true],
  ]);
  expect(check.refusals(off, both)).toEqual(['search.hot_words', 'search.keyword_routes']);
  expect(check.refusals(new Map(), new Map([['payout.x', 1]]))).toEqual([]);
});

it('[AC-B1-05m] a stored value outside the contract is served as an empty list with a warning', async () => {
  const warn = vi.fn();
  const values: Record<string, unknown> = {
    'search.hot_words': [{ text: 'a', weight: 1 }],
    'search.keyword_routes': [{ keyword: 'k', target: { route: 'Gone', params: {} } }],
  };
  const data = await readSearchHotWords(
    {
      config: { configValue: async (_appId, key) => ({ value: values[key] as never, version: 1 }) },
      logger: { warn },
    },
    'app',
  );
  // An unknown route keeps its place: the route table is checked on save, not on read.
  expect(data).toEqual({ hot_words: [], keyword_routes: values['search.keyword_routes'] });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]![0]).toMatchObject({ key: 'search.hot_words', app_id: 'app' });
});
