// B3-05c / B3-05m: public surface of the evaluation wiring. The adapter (createEvalAgent) lives in
// adapter.ts, the local assembly and entry (B3-05m) in local.ts; both are re-exported here.
export { createEvalAgent, isRecordingMiss } from './adapter.ts';
export type {
  EvalAgentDeps,
  EvalBindings,
  EvalInput,
  EvalIntent,
  EvalPorts,
  EvalRun,
  EvalTurnOutput,
} from './adapter.ts';
export { createLocalEvalAgent, createPortTools, decodeToolOutcome, runLocalEval } from './local.ts';
export type {
  EvalToolCatalog,
  LocalEvalAgentDeps,
  LocalEvalCliDeps,
  LocalEvalIo,
  RunLocalEvalDeps,
} from './local.ts';
