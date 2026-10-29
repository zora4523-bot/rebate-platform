// B1-05m: search hot words and keyword shortcuts (GET /v1/search/hot-words) and the save checks of
// their two configuration items. Rule tests: test/spec/catalog/hot-words/**.
export {
  SEARCH_HOT_WORDS_KEY,
  SEARCH_KEYWORD_ROUTES_KEY,
  searchConfigSaveCheck,
  searchHotWordsFit,
  searchKeywordRoutesFit,
} from './check.ts';
export type { SearchConfigCheckContext } from './check.ts';
export { readSearchHotWords } from './read.ts';
export type { SearchHotWordsData, SearchHotWordsReadOptions } from './read.ts';
