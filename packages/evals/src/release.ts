import type { EvalCase, Manifest } from './cases.ts';
import type { RecordingStore } from './replay.ts';
import type { AgentPorts, AgentUnderTest, CaseResult, RunMeta, TurnOutput } from './types.ts';

/** BR-AI-21. Zero-tolerance metrics count clean cases as successes. */
export type ReleaseMetric =
  | 'injection'
  | 'unauthorized'
  | 'banned'
  | 'identity_arg'
  | 'amount_in_text'
  | 'url_in_text'
  | 'card_values'
  | 'attribution'
  | 'recognition'
  | 'platform'
  | 'parameters'
  | 'rights_filter'
  | 'multi_turn'
  | 'chitchat';
export type MetricOutcome = 'pass' | 'fail' | 'coverage_gap' | 'error';

/** Private, versioned oracle alongside the existing EvalCase format; never model output.
 * Field paths are JSON pointers relative to the card payload and one API snapshot.
 * Every emitted numeric field must be covered; no vacuous success for missing cards/sources.
 */
export interface ReleaseExpectation {
  case_id: string;
  cards?: { turn: number; card_id: string; source_id: string; fields: string[] }[];
  recognition?: { turn: number; platform: string };
  attribution?: { turn: number; link_id: string; fields: Record<string, unknown> }[];
  rights?: { turn: number; allowed_card_ids: string[] };
}

/** Server-side observations, not self-reported correctness flags. Each source is one read. */
export interface ReleaseTurnOutput extends TurnOutput {
  trace: TurnOutput['trace'] & {
    sources?: { source_id: string; data: Record<string, unknown> }[];
    recognition?: { recognized: boolean; platform: string | null };
    attributions?: { link_id: string; fields: Record<string, unknown> }[];
  };
}
export interface ReleaseCaseResult extends CaseResult {
  metrics: Partial<Record<ReleaseMetric, MetricOutcome>>;
}
export interface ReleaseReport {
  schema_version: 1;
  meta: RunMeta;
  /** sha256 of canonical JSON of expectations ordered by case_id. */
  expectations_sha256: string;
  cases: ReleaseCaseResult[];
}
export interface ReleaseMetricCount {
  numerator: number;
  denominator: number;
  coverage_gap: number;
  error: number;
  threshold_bp: number;
  passed: boolean;
}
export interface ReleaseVerdict {
  passed: boolean;
  total: number;
  metrics: Record<ReleaseMetric, ReleaseMetricCount>;
  reasons: string[];
}

/** Applicability derives from the case/oracle, never from successful execution.
 * Safety categories, all-case L1 checks, numeric card expectations, find_by_link,
 * expected tool args and multi-turn conversations supply their respective sets.
 * Additional attribution / rights / recognition / card oracles also establish applicability.
 */
export function releaseApplicability(
  c: EvalCase,
  expectation: ReleaseExpectation,
): ReleaseMetric[] {
  void c;
  void expectation;
  throw new Error('NotImplemented: releaseApplicability');
}

export function gradeReleaseCase(
  c: EvalCase,
  outputs: ReleaseTurnOutput[],
  expectation: ReleaseExpectation,
): ReleaseCaseResult {
  void c;
  void outputs;
  void expectation;
  throw new Error('NotImplemented: gradeReleaseCase');
}

/** Full release requires integration mode, >=300 active unique cases, valid manifest/meta,
 * complete case/oracle/metric sets, no error/gap, and every threshold. Ratios use exact counts.
 * T5/T6 have no extra category pass-rate gate. A/B remain diagnostic/candidate comparisons.
 */
export function checkReleaseGate(
  report: ReleaseReport,
  manifest: Manifest,
  cases: EvalCase[],
  expectations: ReleaseExpectation[],
): ReleaseVerdict {
  void report;
  void manifest;
  void cases;
  void expectations;
  throw new Error('NotImplemented: checkReleaseGate');
}

export type ReleaseAgent = (
  input: Parameters<AgentUnderTest>[0],
  ports: AgentPorts,
) => Promise<ReleaseTurnOutput>;

export interface ReleaseRunOptions {
  cases: EvalCase[];
  expectations: ReleaseExpectation[];
  agent: ReleaseAgent;
  meta: RunMeta;
  /** Real-model adapter in production; synthetic port in rule tests. */
  model: AgentPorts['model'];
  timeoutMs?: number;
}

/** B: injected model + content-keyed recorded tools. Integration: injected model + actual
 * server tool/guard entrypoint. Both record errors even if the agent swallows port rejections;
 * stopped cases retain all applicable metrics. No network or credentials inside this package.
 */
export function runCandidate(
  options: ReleaseRunOptions & { store: RecordingStore },
): Promise<ReleaseReport> {
  void options;
  throw new Error('NotImplemented: runCandidate');
}

export function runIntegration(
  options: ReleaseRunOptions & { tool: AgentPorts['tool'] },
): Promise<ReleaseReport> {
  void options;
  throw new Error('NotImplemented: runIntegration');
}

export interface VendorComparison {
  baseline: { vendor: string; model_snapshot: string; mode: RunMeta['mode'] };
  candidate: { vendor: string; model_snapshot: string; mode: RunMeta['mode'] };
  usable: boolean;
  rows: {
    metric: ReleaseMetric;
    baseline: { numerator: number; denominator: number };
    candidate: { numerator: number; denominator: number };
    delta_percentage_points: number | null;
    status: 'comparable' | 'insufficient_evidence' | 'not_comparable';
  }[];
}

/** Caller chooses diagnostic minimum sample size; no new release threshold is introduced.
 * Compare identical experiment/case sets (vendor/snapshot may differ). A/B/integration are
 * not interchangeable. Unsafe/invalid runs cannot be used for model selection.
 */
export function compareVendors(
  baseline: ReleaseReport,
  candidate: ReleaseReport,
  minimumSampleSize: number,
): VendorComparison {
  void baseline;
  void candidate;
  void minimumSampleSize;
  throw new Error('NotImplemented: compareVendors');
}
