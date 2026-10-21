// B3-05g · BR-AI-05 / BR-AI-08 / BR-AI-24: result sets and references, refinement (再便宜点 /
// 换一批 / 换平台), price checks with one clarify per chain and slot, no-result relaxation within
// the run's tool budget and the relaxed flag for match tagging; ResultSetStore port + memory store.
export type {
  DeliveredProduct,
  ResultSetInput,
  ResultSetStore,
  ResultsContinuationDeps,
  ResultsDeps,
  SearchConditions,
  StoredResultSet,
} from './types.ts';
export { createMemoryResultSetStore } from './store.ts';
export { readSearchParams } from './shared.ts';
export { createResultsTools } from './tools.ts';
export { createClarification, createReferenceResolver, createRefinement } from './continuation.ts';
