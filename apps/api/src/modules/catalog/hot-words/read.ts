// B1-05m: GET /v1/search/hot-words (contracts getSearchHotWords; D10-419 (a) 1 / 3). The two
// configuration items of the caller's app, returned as stored and in their order; no row gives an
// empty list and nothing is made up. A stored value outside SearchHotWordsData (written around the
// console's save check) is served as an empty list, never cut down, so the response stays within
// the contract; the route table is not re-checked here (a target is checked when saved, and the
// client checks it against its own table before opening).
import type { Schema } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import type { CatalogConfigReader } from '../ports.ts';
import { SEARCH_HOT_WORDS_KEY, SEARCH_KEYWORD_ROUTES_KEY, searchHotWordsFit } from './check.ts';

export type SearchHotWordsData = Schema<'SearchHotWordsData'>;

const MAX_KEYWORD_ROUTES = 50;

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** SearchKeywordRoute: keyword 1–20 characters, target {route (non-empty), params?: object}. */
function keywordRouteShaped(item: unknown): boolean {
  if (!isPlainObject(item)) return false;
  if (!Object.keys(item).every((key) => key === 'keyword' || key === 'target')) return false;
  const keyword = item['keyword'];
  const target = item['target'];
  if (typeof keyword !== 'string') return false;
  const length = [...keyword].length;
  if (length < 1 || length > 20 || !isPlainObject(target)) return false;
  if (!Object.keys(target).every((key) => key === 'route' || key === 'params')) return false;
  const route = target['route'];
  return (
    typeof route === 'string' &&
    route !== '' &&
    (!Object.hasOwn(target, 'params') || isPlainObject(target['params']))
  );
}

function keywordRoutesShaped(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length <= MAX_KEYWORD_ROUTES && value.every(keywordRouteShaped)
  );
}

export interface SearchHotWordsReadOptions {
  readonly config: Pick<CatalogConfigReader, 'configValue'>;
  readonly logger: Pick<Logger, 'warn'>;
}

export async function readSearchHotWords(
  options: SearchHotWordsReadOptions,
  appId: string,
): Promise<SearchHotWordsData> {
  const [words, routes] = await Promise.all([
    options.config.configValue(appId, SEARCH_HOT_WORDS_KEY),
    options.config.configValue(appId, SEARCH_KEYWORD_ROUTES_KEY),
  ]);
  const listOf = <T>(key: string, row: { readonly value: unknown } | null, fits: boolean): T[] => {
    if (row === null) return [];
    if (fits) return row.value as T[];
    options.logger.warn({ event: 'search_config_unusable', app_id: appId, key }, 'served as empty');
    return [];
  };
  return {
    hot_words: listOf(SEARCH_HOT_WORDS_KEY, words, searchHotWordsFit(words?.value)),
    keyword_routes: listOf(SEARCH_KEYWORD_ROUTES_KEY, routes, keywordRoutesShaped(routes?.value)),
  };
}
