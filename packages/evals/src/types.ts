// Shapes of part 2 (B3-01b): recordings, the agent under test, case results and the report.
// Stream frames follow contracts/agent-stream.schema.json (04 §8.1–8.3); the grader reads only
// `event`, `data.delta` of text.delta frames and `data.type` of card frames.
import type { Category, EvalSet, Intent, Provenance, Split, Subject } from './cases.ts';

/** The full request sent to the model (after redaction). */
export interface ModelRequest {
  vendor: string;
  model: string;
  messages: unknown[];
  tools: unknown[];
  params: Record<string, unknown>;
  /** For live calls the runner overwrites this with the calling case's trusted provenance. */
  provenance?: Provenance;
}

/** A tool call together with the session state and configuration it depends on. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  state: { turn: number; result_set_ids: string[]; tool_set: string[] };
  config_fingerprint: string;
}

/** One line of a recording file (schema/recording.schema.json). */
export interface Recording {
  kind: 'model' | 'tool';
  key: string;
  response: unknown;
  recorded_at: string;
}

export type ProblemCode = string;

/** One SSE frame as emitted (heartbeats are not frames). */
export interface StreamFrame {
  event: string;
  id: number;
  data: Record<string, unknown>;
}

export interface TurnOutput {
  frames: StreamFrame[];
  trace: {
    card_sources?: { card_id: string; fields: Record<string, number | string | boolean | null> }[];
    link_registrations?: { link_id: string; product_key: string; ok: boolean }[];
    intent: Intent | null;
    tool_calls: {
      name: string;
      args: Record<string, unknown>;
      status: 'ok' | 'rejected' | 'failed';
    }[];
  };
}

export interface AgentPorts {
  model(req: ModelRequest): Promise<unknown>;
  tool(call: ToolCall): Promise<unknown>;
}

export type AgentUnderTest = (
  input: {
    case_id: string;
    turn: number;
    text: string;
    untrusted: boolean;
    subject: Subject;
    switches: Record<string, boolean>;
  },
  ports: AgentPorts,
) => Promise<TurnOutput>;

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
  /** Required in mode A: digest of all recording lines (canonical JSON, ordered by key). */
  recordings_sha256: string | null;
  unused_recordings: number;
  started_at: string;
  finished_at: string;
}

export interface ResultCounts {
  total: number;
  pass: number;
  fail: number;
  coverage_gap: number;
  error: number;
}

export interface Report {
  schema_version: 1;
  meta: RunMeta;
  /** Ordered by id (UTF-16 code units). */
  cases: CaseResult[];
  summary: ResultCounts & {
    by_category: Partial<Record<Category, ResultCounts>>;
    /** Number of cases with at least one problem of that code. */
    counters: { amount_in_text: number; url_in_text: number; identity_arg: number };
  };
}

/**
 * What a local replay writes back (BR-AI-21): pass or fail and counts only, never case ids,
 * case text or problem messages.
 */
export interface SmokeVerdict {
  passed: boolean;
  /** name@version */
  eval_set: string;
  content_sha256: string;
  /** sha256Hex(canonicalJson(report)) */
  report_sha256: string;
  total: number;
  pass: number;
  fail: number;
  coverage_gap: number;
  error: number;
}
