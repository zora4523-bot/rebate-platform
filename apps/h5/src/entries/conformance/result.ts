import type {
  CaseExpectation,
  CaseOutcome,
  CaseResult,
  ConformanceCase,
  ConformanceResult,
} from './model.ts';

export const RESULT_SCHEMA = 'couli.bridge-conformance/1';

/** `{ code }` needs that exact failure code; `{ ok }` compares success or failure only. */
export function passes(expected: CaseExpectation, outcome: CaseOutcome): boolean {
  if ('code' in expected) return !outcome.ok && outcome.code === expected.code;
  return outcome.ok === expected.ok;
}

function summarize(cases: readonly CaseResult[]): ConformanceResult['summary'] {
  return {
    total: cases.length,
    passed: cases.filter((row) => row.pass === true).length,
    failed: cases.filter((row) => row.pass === false).length,
    pending: cases.filter((row) => row.pass === null).length,
  };
}

function pendingRow(row: ConformanceCase): CaseResult {
  const pending: CaseResult = {
    id: row.id,
    method: row.method,
    category: row.category,
    trigger: row.trigger,
    expect: { ...row.expect },
    outcome: null,
    pass: null,
    ms: null,
  };
  if (row.platforms !== undefined) pending.platforms = [...row.platforms];
  return pending;
}

export function createResult(
  cases: readonly ConformanceCase[],
  bridgePresent: boolean,
  unknownCases: readonly string[],
): ConformanceResult {
  const rows = cases.map(pendingRow);
  return {
    schema: RESULT_SCHEMA,
    status: 'running',
    bridge_present: bridgePresent,
    cases: rows,
    events: { 'app.resume': [], 'app.pause': [] },
    unknown_cases: [...unknownCases],
    summary: summarize(rows),
  };
}

/** Replace one row's observation and recompute totals, including repeated button clicks. */
export function recordOutcome(
  result: ConformanceResult,
  id: string,
  outcome: CaseOutcome,
  ms: number,
): ConformanceResult {
  if (!result.cases.some((row) => row.id === id)) return result;
  const cases = result.cases.map((row) =>
    row.id === id
      ? { ...row, outcome: { ...outcome }, pass: passes(row.expect, outcome), ms }
      : row,
  );
  return { ...result, cases, summary: summarize(cases) };
}

/**
 * Swap in the rows of the resolved platform. Rows already present keep their observation;
 * events, status and unknown_cases are untouched.
 */
export function replaceCases(
  result: ConformanceResult,
  cases: readonly ConformanceCase[],
): ConformanceResult {
  const previous = new Map(result.cases.map((row) => [row.id, row]));
  const rows = cases.map((row) => previous.get(row.id) ?? pendingRow(row));
  return { ...result, cases: rows, summary: summarize(rows) };
}

export function completeAutoRuns(result: ConformanceResult): ConformanceResult {
  return { ...result, status: 'done' };
}

/** Event data is kept as delivered; the native UI suites assert it is `{}`. */
export function recordEvent(
  result: ConformanceResult,
  event: keyof ConformanceResult['events'],
  data: unknown,
): ConformanceResult {
  return { ...result, events: { ...result.events, [event]: [...result.events[event], data] } };
}
