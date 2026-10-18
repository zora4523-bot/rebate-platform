// B3-04b · the search port types, apart from index.ts so pipeline.ts does not import the barrel
// (dependency-cruiser no-circular).
import type {
  CatalogCardEntry,
  CatalogConfigReader,
  SearchCandidate,
  SearchProductsQuery,
} from '../../../catalog/index.ts';
import type { Clock } from '../../../platform/index.ts';
import type { ToolCallContext } from '../registry/index.ts';

/** Normalized candidates in upstream rank order; no platform wire payloads here. */
export interface AgentSearchCandidate extends SearchCandidate {
  readonly categoryId: string;
  readonly sales: number | null;
}

export interface SearchProductsDeps {
  readonly clock: Clock;
  readonly config: CatalogConfigReader;
  readonly platforms: readonly SearchProductsQuery['platform'][];
  /**
   * Retrieval seam: catalog's query and candidate types, before card/link delivery.
   * The HTTP searchProducts return type already contains registered links and cannot be
   * used as this port's result. Wiring must preserve upstream rank and defer registration.
   */
  readonly searchProducts: (
    query: SearchProductsQuery,
    ctx: ToolCallContext,
  ) => Promise<readonly AgentSearchCandidate[]>;
  readonly cardEntry: (ctx: ToolCallContext) => CatalogCardEntry;
  readonly prohibited: (appId: string, q: string) => Promise<boolean>;
  readonly categoryAllowed: (appId: string, candidate: AgentSearchCandidate) => Promise<boolean>;
  readonly newResultSetId: () => string;
  /** References supplied by the run's numbering owner, including the list container offset.
   * Never number the outgoing UnnumberedCard here. index is the delivered item index.
   */
  readonly cardReference: (ctx: ToolCallContext, index: number) => string;
  /** Dictionary text for a card's fallback_text (BR-TEXT-12); the text key when not wired. */
  readonly texts?: (appId: string, key: string) => Promise<string>;
}
