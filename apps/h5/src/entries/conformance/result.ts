import type { CaseOutcome, ConformanceCase, ConformanceResult } from './model.ts';

export function createResult(
  cases: readonly ConformanceCase[],
  bridgePresent: boolean,
  unknownCases: readonly string[],
): ConformanceResult {
  void cases;
  void bridgePresent;
  void unknownCases;
  throw new Error('NotImplemented: createResult');
}

/** Replace one row's observation and recompute totals, including repeated button clicks. */
export function recordOutcome(
  result: ConformanceResult,
  id: string,
  outcome: CaseOutcome,
  ms: number,
): ConformanceResult {
  void result;
  void id;
  void outcome;
  void ms;
  throw new Error('NotImplemented: recordOutcome');
}

export function completeAutoRuns(result: ConformanceResult): ConformanceResult {
  void result;
  throw new Error('NotImplemented: completeAutoRuns');
}
