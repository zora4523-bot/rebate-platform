// B1-05m (规划/01 F-PROD-03; contracts getSearchHotWords, SearchHotWordsData, RouteTarget;
// BR-ATTR-29 ①; D10-419 (a)): the save checks of search.hot_words and search.keyword_routes,
// pure. A value fits only when every item does (no partial save); the caller turns a refusal into
// 20001 with the config item route's fields. Route names and params come from contracts/routes.json
// (the generated bridge route table), never from a copied list; union domains from the platform
// link pattern table (category union_host), and only while external_page.union_host_block is on.
import type { LinkPatternsSpec } from '../../platform/index.ts';

/** What the keyword route check reads besides the value. */
export interface SearchConfigCheckContext {
  /** external_page.union_host_block (default on: only a stored false turns it off). */
  readonly unionHostBlock: boolean;
  readonly linkPatterns: LinkPatternsSpec;
}

/** Whether `value` may be saved as search.hot_words: a list of `{text}`, text not blank. */
export function searchHotWordsFit(value: unknown): boolean {
  void value;
  throw new Error('NotImplemented: searchHotWordsFit');
}

/**
 * Whether `value` may be saved as search.keyword_routes: a list of `{keyword, target}`, keyword
 * not empty, target a RouteTarget of contracts/routes.json with params as that route defines them;
 * an ExternalPage url on a union domain is refused while the switch is on.
 */
export function searchKeywordRoutesFit(value: unknown, context: SearchConfigCheckContext): boolean {
  void value;
  void context;
  throw new Error('NotImplemented: searchKeywordRoutesFit');
}
