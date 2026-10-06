import type { Category, EvalCase, Manifest, Problem } from './cases.ts';
import type { RecordingStore } from './replay.ts';
import type { AgentPorts, AgentUnderTest, Report, RunMeta, TurnOutput } from './types.ts';

export interface CheckCount {
  checked: number;
  verified: number;
  mismatched: number;
  unverified: number;
}
export interface CaseFacts {
  id: string;
  graded: boolean;
  card_values: CheckCount;
  attribution: CheckCount;
  platform: 'ok' | 'mismatch' | null;
}
export type MetricId =
  | 'full_count'
  | 'block_injection'
  | 'block_unauthorized'
  | 'block_banned'
  | 'leak_identity_arg'
  | 'leak_amount'
  | 'leak_url'
  | 'card_values'
  | 'attribution'
  | 't1_recognition'
  | 't1_platform'
  | 't2_params'
  | 't3_benefits'
  | 't4_multiturn'
  | 'chitchat_refusal'
  | 't5_observe'
  | 't6_observe';
export type MetricStatus = 'pass' | 'fail' | 'not_covered' | 'observe';
export interface Metric {
  id: MetricId;
  numerator: number;
  denominator: number;
  status: MetricStatus;
}
export interface ReleaseVerdict {
  passed: boolean;
  eval_set: string;
  content_sha256: string;
  report_sha256: string;
  mode: RunMeta['mode'];
  vendor: string;
  model_snapshot: string;
  metrics: Metric[];
}

export function computeFacts(c: EvalCase, outputs: TurnOutput[]): CaseFacts {
  void c;
  void outputs;
  throw new Error('NotImplemented: computeFacts');
}

export async function runEval(opts: {
  cases: EvalCase[];
  agent: AgentUnderTest;
  meta: RunMeta;
  store?: RecordingStore;
  live?: Partial<AgentPorts>;
  timeoutMs?: number;
}): Promise<{ report: Report; facts: CaseFacts[] }> {
  void opts;
  throw new Error('NotImplemented: runEval');
}

export function computeMetrics(report: Report, facts: CaseFacts[]): Metric[] {
  void report;
  void facts;
  throw new Error('NotImplemented: computeMetrics');
}

export function checkReleaseGate(
  report: Report,
  manifest: Manifest,
  cases: EvalCase[],
  facts: CaseFacts[],
): { passed: boolean; problems: Problem[]; verdict: ReleaseVerdict } {
  void report;
  void manifest;
  void cases;
  void facts;
  throw new Error('NotImplemented: checkReleaseGate');
}

export function compareReports(
  a: Report,
  b: Report,
  opts?: { minSample?: number },
): {
  problems: Problem[];
  header: {
    a: { vendor: string; model_snapshot: string; mode: RunMeta['mode'] };
    b: { vendor: string; model_snapshot: string; mode: RunMeta['mode'] };
  };
  rows: {
    scope: Category | 'all';
    a: { n: number; pass: number };
    b: { n: number; pass: number };
    delta_pp: number | null;
    status: 'compared' | 'insufficient';
  }[];
} {
  void a;
  void b;
  void opts;
  throw new Error('NotImplemented: compareReports');
}
