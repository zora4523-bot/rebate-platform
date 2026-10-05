import type { Category, EvalCase, EvalSet, Intent, Manifest, Problem, Split, Subject } from './index.ts';

export interface ModelRequest {
  vendor: string;
  model: string;
  messages: unknown[];
  tools: unknown[];
  params: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  state: { turn: number; result_set_ids: string[]; tool_set: string[] };
  config_fingerprint: string;
}

export interface Recording {
  kind: 'model' | 'tool';
  key: string;
  response: unknown;
  recorded_at: string;
}

export type ProblemCode = string;

export function sha256Hex(text: string): string {
  void text;
  throw new Error('NotImplemented: sha256Hex');
}

export function modelKey(req: ModelRequest): string {
  void req;
  throw new Error('NotImplemented: modelKey');
}

export function toolKey(call: ToolCall): string {
  void call;
  throw new Error('NotImplemented: toolKey');
}

export class RecordingMiss extends Error {
  declare readonly kind: Recording['kind'];
  declare readonly key: string;

  constructor(kind: Recording['kind'], key: string) {
    super('NotImplemented: RecordingMiss');
    void kind;
    void key;
    throw new Error('NotImplemented: RecordingMiss');
  }
}

export class RecordingStore {
  model(req: ModelRequest): unknown {
    void req;
    throw new Error('NotImplemented: RecordingStore.model');
  }

  tool(call: ToolCall): unknown {
    void call;
    throw new Error('NotImplemented: RecordingStore.tool');
  }

  unused(): { kind: Recording['kind']; key: string }[] {
    throw new Error('NotImplemented: RecordingStore.unused');
  }
}

export function loadRecordings(text: string, file: string): { store: RecordingStore; problems: Problem[] } {
  void text;
  void file;
  throw new Error('NotImplemented: loadRecordings');
}

export interface StreamFrame {
  event: string;
  id: number;
  data: Record<string, unknown>;
}

export interface TurnOutput {
  frames: StreamFrame[];
  trace: {
    intent: Intent | null;
    tool_calls: { name: string; args: Record<string, unknown>; status: 'ok' | 'rejected' | 'failed' }[];
  };
}

export interface AgentPorts {
  model(req: ModelRequest): Promise<unknown>;
  tool(call: ToolCall): Promise<unknown>;
}

export type AgentUnderTest = (input: {
  case_id: string;
  turn: number;
  text: string;
  untrusted: boolean;
  subject: Subject;
  switches: Record<string, boolean>;
}, ports: AgentPorts) => Promise<TurnOutput>;

export type ResultType = 'pass' | 'fail' | 'coverage_gap' | 'error';
export type Layer = 'L1' | 'L3';
export interface CaseProblem {
  code: string;
  layer: Layer | null;
  turn: number | null;
  message: string;
}
export interface CaseResult {
  id: string;
  category: Category;
  split: Split;
  result: ResultType;
  first_failed_layer: Layer | null;
  problems: CaseProblem[];
}

export interface RunMeta {
  mode: 'A' | 'B' | 'integration';
  vendor: string;
  model_snapshot: string;
  prompt_sha256: string;
  sampling: Record<string, unknown>;
  eval_set: { set: EvalSet; version: string; content_sha256: string; split_sha256: string };
  tool_schema_version: string;
  code_commit: string;
  grader_version: string;
  recordings_sha256: string | null;
  unused_recordings: number;
  started_at: string;
  finished_at: string;
}

export interface Report {
  schema_version: 1;
  meta: RunMeta;
  cases: CaseResult[];
  summary: {
    total: number;
    pass: number;
    fail: number;
    coverage_gap: number;
    error: number;
    by_category: Partial<Record<Category, {
      total: number; pass: number; fail: number; coverage_gap: number; error: number;
    }>>;
    counters: { amount_in_text: number; url_in_text: number; identity_arg: number };
  };
}

export interface SmokeVerdict {
  passed: boolean;
  eval_set: string;
  content_sha256: string;
  report_sha256: string;
  total: number;
  pass: number;
  fail: number;
  coverage_gap: number;
  error: number;
}

export function runReplay(opts: {
  cases: EvalCase[];
  agent: AgentUnderTest;
  store: RecordingStore;
  meta: RunMeta;
  timeoutMs?: number;
}): Promise<Report> {
  void opts;
  throw new Error('NotImplemented: runReplay');
}

export function gradeCase(c: EvalCase, outputs: TurnOutput[], identityFields: readonly string[]): CaseResult {
  void c;
  void outputs;
  void identityFields;
  throw new Error('NotImplemented: gradeCase');
}

export function summarize(cases: CaseResult[]): Report['summary'] {
  void cases;
  throw new Error('NotImplemented: summarize');
}

export function checkReport(report: Report, manifest: Manifest, cases: EvalCase[]): Problem[] {
  void report;
  void manifest;
  void cases;
  throw new Error('NotImplemented: checkReport');
}

export function checkSmokeGate(report: Report, manifest: Manifest, cases: EvalCase[]): {
  passed: boolean; problems: Problem[]; verdict: SmokeVerdict;
} {
  void report;
  void manifest;
  void cases;
  throw new Error('NotImplemented: checkSmokeGate');
}

export function checkDuplicateIds(cases: EvalCase[], files: string[]): Problem[] {
  void cases;
  void files;
  throw new Error('NotImplemented: checkDuplicateIds');
}
