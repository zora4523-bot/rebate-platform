// @couli/evals: Agent eval framework (BR-AI-21). Part 1 (B3-01a, ./cases.ts): eval case and
// manifest shapes, JSONL loading and the set-level checks. Part 2 (B3-01b): recordings and
// content-keyed replay (./replay.ts), rule grading (./grade.ts), the report and the smoke merge
// gate (./report.ts); the command line is ./cli.ts. Only loaders, schemas and synthetic samples
// live in this public repository; real eval sets, prompts and recordings stay in private storage.
export { canonicalJson, sha256Hex } from './canonical.ts';
export {
  EVAL_SETS,
  CATEGORIES,
  SPLITS,
  PROVENANCES,
  SUBJECTS,
  INTENTS,
  FORBIDS,
  SMOKE_MIN_TOTAL,
  SMOKE_MIN_PER_CATEGORY,
  SMOKE_REQUIRED_CATEGORIES,
  validateCase,
  validateManifest,
  parseJsonl,
  computeManifest,
  checkManifest,
  checkSplitLeak,
  normalizeTurns,
  checkNearDuplicates,
  checkAppendOnly,
  checkSmokeComposition,
  checkDuplicateIds,
} from './cases.ts';
export type {
  EvalSet,
  Category,
  Split,
  Provenance,
  Subject,
  Intent,
  Forbid,
  EvalCase,
  Manifest,
  Problem,
} from './cases.ts';
export {
  IDENTITY_FIELDS,
  normalizeIdentityKey,
  checkIdentityFieldsFile,
  gradeCase,
} from './grade.ts';
export {
  modelKey,
  toolKey,
  RecordingMiss,
  RecordingStore,
  loadRecordings,
  runReplay,
} from './replay.ts';
export { summarize, checkReport, checkSmokeGate } from './report.ts';
export type {
  ModelRequest,
  ToolCall,
  Recording,
  StreamFrame,
  TurnOutput,
  AgentPorts,
  AgentUnderTest,
  ResultType,
  Layer,
  CaseProblem,
  CaseResult,
  ResultCounts,
  RunMeta,
  Report,
  SmokeVerdict,
  ProblemCode,
} from './types.ts';
