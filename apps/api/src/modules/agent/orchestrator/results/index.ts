// B3-05g · BR-AI-05 / BR-AI-08 / BR-AI-24. Test-phase port skeletons only.
import type { Platform } from '@couli/contracts-ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { MatchDeps } from '../../tools/match/index.ts';
import type { RebateQuoteDeps } from '../../tools/quote/index.ts';
import type { SearchSort } from '../../tools/search/schema.ts';
import type { OrchestratorLimits, OrchestratorTools } from '../core/ports.ts';
import type { ClarificationScope, ClarifySlot, IntentDeps } from '../intents/types.ts';

/** Server-owned conditions; chain_id is never accepted from model tool arguments. */
export type SearchConditions = {
  readonly q: string;
  readonly platforms?: readonly Platform[];
  readonly sort?: SearchSort;
  readonly price_min_fen?: number;
  readonly price_max_fen?: number;
  readonly spec?: string;
  readonly page?: number;
  readonly chain_id: string;
};

/** Only actual delivery receipts populate this server-only snapshot. */
export interface DeliveredProduct {
  readonly card_id: string;
  readonly product_key: string;
  readonly platform: Platform;
  readonly final_price_fen: number;
  readonly card: UnnumberedCard;
}

export interface ResultSetInput {
  readonly id: string;
  readonly appId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly conditions: SearchConditions;
}

export interface StoredResultSet extends ResultSetInput {
  readonly delivered: readonly DeliveredProduct[];
}

export interface ResultSetStore {
  /** Persist conditions separately from delivered cards/prices, under product_list.result_set_id. */
  save(value: ResultSetInput): Promise<void>;
  /** Trusted delivery hook, not a model tool. PG/core receipt wiring belongs to later tasks. */
  recordDelivered(resultSetId: string, items: readonly DeliveredProduct[]): Promise<void>;
  latestWithProducts(appId: string, sessionId: string): Promise<StoredResultSet | null>;
  /** Earlier rounds remain addressable; all lookup dimensions come from server context. */
  findDelivered(appId: string, sessionId: string, cardId: string): Promise<DeliveredProduct | null>;
  takeOnce(scope: ClarificationScope, slot: ClarifySlot): Promise<boolean>;
}

export interface ResultsDeps {
  readonly store: ResultSetStore;
  readonly texts: IntentDeps['texts'];
  readonly limits: OrchestratorLimits;
  readonly match?: MatchDeps;
}

/** tools is the decorated port, sharing store with clarification and refinement. */
export interface ResultsContinuationDeps extends ResultsDeps {
  readonly tools: OrchestratorTools;
}

export function createMemoryResultSetStore(): ResultSetStore {
  throw new Error('NotImplemented: createMemoryResultSetStore');
}

/** Read effective handler metadata, never assume ToolTraceFragment has search_params. */
export function readSearchParams(trace: unknown): { spec: string | null; page: number } | null {
  void trace;
  throw new Error('NotImplemented: readSearchParams');
}

/** Counts all execute calls and relaxation calls per app/session/run; forwards ctx unchanged. */
export function createResultsTools(inner: OrchestratorTools, deps: ResultsDeps): OrchestratorTools {
  void inner;
  void deps;
  throw new Error('NotImplemented: createResultsTools');
}

/** One clarification per slot/chain; new searches start chains, refinements retain them. */
export function createClarification(deps: ResultsContinuationDeps): IntentDeps['clarification'] {
  void deps;
  throw new Error('NotImplemented: createClarification');
}

export function createRefinement(
  deps: ResultsContinuationDeps,
): Pick<IntentDeps['continuation'], 'run'> {
  void deps;
  throw new Error('NotImplemented: createRefinement');
}

export function createReferenceResolver(
  deps: Pick<ResultsDeps, 'store'>,
): RebateQuoteDeps['references'] {
  void deps;
  throw new Error('NotImplemented: createReferenceResolver');
}
