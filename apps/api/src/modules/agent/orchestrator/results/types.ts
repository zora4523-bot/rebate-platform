// B3-05g · BR-AI-05 / BR-AI-08 / BR-AI-24: result sets, references, refinement and relaxation.
import type { Platform } from '@couli/contracts-ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { MatchDeps } from '../../tools/match/index.ts';
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
