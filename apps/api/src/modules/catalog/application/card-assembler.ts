import type { components } from '@couli/contracts-ts';
import type { Clock } from '../../platform/index.ts';
import type { UnionEnvironment, UnionItem, UnionMode } from '../../union/index.ts';
import type { ProductRef } from '../domain/types.ts';
import type {
  CatalogConfigReader,
  LinkRegistrar,
  RebateQuote,
  RebateQuoter,
  SourceLinkReader,
  Viewer,
  ViewerContext,
} from '../ports.ts';
import type { ItemRefService } from './item-ref.ts';

export type ProductCard = components['schemas']['ProductCard'];

/** entry_source is opaque text in links, not a new contract enumeration. */
export interface CardQuoteContext {
  readonly buyType: 'self';
  readonly entrySource: string | null;
  readonly rebateBasis: 'normal' | 'price_compare_risk';
}

/** Optional third argument keeps the B1-05c port compatible; card calls always supply it. */
export interface CardRebateQuoter extends RebateQuoter {
  quote(item: UnionItem, viewer: Viewer, context?: CardQuoteContext): Promise<RebateQuote>;
}

export interface AssembleCardInput {
  readonly item: UnionItem;
  readonly ref: ProductRef;
  readonly entrySource: string | null;
  /** Detail/derived requests read the originating link in the server's app scope. */
  readonly sourceLinkId?: string;
  readonly stale: boolean;
}

export interface CardAssemblerOptions {
  readonly clock: Clock;
  readonly viewerContext: ViewerContext;
  readonly quoter: CardRebateQuoter;
  readonly registrar: LinkRegistrar;
  readonly sourceLinks: SourceLinkReader;
  readonly itemRefs: Pick<ItemRefService, 'issue'>;
}

export interface CardAssembler {
  /** Only priced cards here; caller owns filtering, refill and cache eligibility. */
  assemble(input: AssembleCardInput): Promise<ProductCard>;
}

/** Implementation phase adds the public export, without registering a Nest provider yet. */
export function createCardAssembler(options: CardAssemblerOptions): CardAssembler {
  void options;
  throw new Error('NotImplemented: createCardAssembler');
}

/** Synthetic non-production rule schema; no defaults or production rule/level storage. */
export interface DemoQuoteRule {
  readonly reserve_bp: number;
  readonly self_share_bp: number;
}

export interface DemoRebateQuoterOptions {
  readonly appEnv: UnionEnvironment;
  readonly unionMode: UnionMode;
  readonly config: CatalogConfigReader;
  /** Explicit synthetic config key, value DemoQuoteRule; never a commission_rules writer. */
  readonly ruleConfigKey: string;
}

/** tech_fee_bp[platform] and rebate.taobao.compare_rate_ratio_bp use CatalogConfigReader. */
export function createDemoRebateQuoter(options: DemoRebateQuoterOptions): CardRebateQuoter {
  void options;
  throw new Error('NotImplemented: createDemoRebateQuoter');
}
