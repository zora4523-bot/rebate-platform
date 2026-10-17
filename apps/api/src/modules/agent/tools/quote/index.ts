import type { CatalogCardEntry } from '../../../catalog/index.ts';
import type { Candidate, ParsedUrlProduct, ParsingErrorCode } from '../../../parsing/index.ts';
import type { CallCtx } from '../../../union/index.ts';
import type { ToolOutcome } from '../../orchestrator/index.ts';
import type { ToolCallContext, ToolHandler } from '../registry/index.ts';

/** Server-side lookup only: earlier turns are eligible; ordinals use the latest product list. */
export type QuoteReference = { readonly card_id: string } | { readonly ref_ordinal: number };

export type QuoteReferenceResult =
  | { readonly kind: 'product'; readonly productKey: string }
  | { readonly kind: 'invalid_args' }
  | { readonly kind: 'clarify' };

export interface RebateQuoteDeps {
  /** Bound parsing.parseUrl (its ParsingOptions are supplied by the composition root). */
  readonly parsing: {
    parseUrl(url: string, context: CallCtx): Promise<ParsedUrlProduct>;
  };
  readonly catalog: {
    /** Fresh catalog lookup; never a model-supplied or previously displayed price snapshot. */
    readProduct(productKey: string, context: ToolCallContext): Promise<ParsedUrlProduct>;
    /** Request-scoped viewer and registrar. Use active_query and deferLink before filtering. */
    cards(context: ToolCallContext): CatalogCardEntry;
  };
  readonly references: {
    resolve(reference: QuoteReference, context: ToolCallContext): Promise<QuoteReferenceResult>;
  };
}

/** Internal outcomes for B3-05e, not new public error codes or fabricated wire cards. */
export type LinkQuoteOutcome =
  | Extract<ToolOutcome, { readonly kind: 'ok' }>
  | {
      readonly kind: 'parse_error';
      readonly error_code: ParsingErrorCode;
      readonly cards: readonly [];
    }
  | { readonly kind: 'price_unavailable'; readonly cards: readonly [] }
  | { readonly kind: 'no_card'; readonly cards: readonly [] };

export interface LinkQuoteRunner {
  /** Called by the deterministic path with a parse_input URL candidate, never by the model. */
  run(
    candidate: Candidate & { readonly kind: 'url' },
    context: ToolCallContext,
  ): Promise<LinkQuoteOutcome>;
}

/** Model arguments: exactly one of card_id, ref_ordinal, or the unchanged context product_key. */
export function createRebateQuoteHandler(deps: RebateQuoteDeps): ToolHandler {
  void deps;
  throw new Error('NotImplemented: createRebateQuoteHandler');
}

export function createLinkQuoteRunner(deps: RebateQuoteDeps): LinkQuoteRunner {
  void deps;
  throw new Error('NotImplemented: createLinkQuoteRunner');
}
