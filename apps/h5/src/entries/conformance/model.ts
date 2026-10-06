import type { bridge } from '@couli/contracts-ts';

export type ConformancePlatform = bridge.BridgeMethods['app.getEnv']['result']['platform'];

export type CaseCategory =
  'normal' | 'timeout' | 'unsupported' | 'bad_params' | 'no_gesture' | 'negative';

export type CaseTrigger = 'auto' | 'tap' | 'harness';
export type CaseExpectation = { ok: true } | { code: number } | { ok: false };
export type CaseOutcome = { ok: true } | { ok: false; code: number };

export interface ConformanceCase {
  id: string;
  method: string;
  category: CaseCategory;
  expect: CaseExpectation;
  trigger: CaseTrigger;
  platforms?: ConformancePlatform[];
}

export interface CaseResult extends ConformanceCase {
  outcome: CaseOutcome | null;
  pass: boolean | null;
  ms: number | null;
}

export interface ConformanceResult {
  schema: 'couli.bridge-conformance/1';
  status: 'running' | 'done';
  bridge_present: boolean;
  cases: CaseResult[];
  events: { 'app.resume': unknown[]; 'app.pause': unknown[] };
  unknown_cases: string[];
  summary: { total: number; passed: number; failed: number; pending: number };
}

/** Internal parent/child wire format; no bridge response data crosses this boundary. */
export interface FrameReport {
  type: 'couli.bridge-conformance/frame';
  outcome: CaseOutcome;
}
