import type { ConformanceCase } from './model.ts';

/** Build metadata from bridgeMethods and parameter schemas, including contract-backed negatives. */
export function buildCaseTable(): ConformanceCase[] {
  throw new Error('NotImplemented: buildCaseTable');
}

/** Params stay outside the public result object. */
export function paramsForCase(testCase: ConformanceCase): unknown {
  void testCase;
  throw new Error('NotImplemented: paramsForCase');
}

/** No cases query retains harness rows as pending; an explicit query selects only its IDs. */
export function selectCases(
  cases: readonly ConformanceCase[],
  search: string,
): { cases: ConformanceCase[]; unknown_cases: string[] } {
  void cases;
  void search;
  throw new Error('NotImplemented: selectCases');
}
