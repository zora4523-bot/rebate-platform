// B3-05f: types of the intent port (module-internal model protocol and the injected ports).
import type {
  DisplayStatus,
  OrderReason,
  PageGuideRejectReason,
  Platform,
} from '@couli/contracts-ts';
import type { PathInput } from '../core/ports.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import type { SuggestionsData } from '../../stream/writer/index.ts';

export type ClarifySlot = 'reference' | 'price' | 'platform';

/** Internal model protocol (not an HTTP contract). Every object is closed, including conditions.
 * page_guide is exactly contracts/agent-stream.schema.json $defs/page_guide_intent; even an
 * empty string is structurally valid, but route membership is checked by handle.
 * Other intents have only the fields below; earnings topic is optional (default summary).
 * clarify requires a slot. ref_ordinal requires a positive safe integer; refine requires a
 * nonempty conditions object with a contract platform / finite numeric price fields. Actual
 * reference and price semantics are delegated to B3-05g, not evaluated by this parser.
 * Bare intents require only agent_intent. No model text, identity, route params or suggestions.
 */
export type IntentOutput =
  | { readonly agent_intent: 'page_guide'; readonly guide_route: string }
  | { readonly agent_intent: 'earnings_query'; readonly topic?: 'summary' | 'withdrawal_progress' }
  | { readonly agent_intent: 'clarify'; readonly slot: ClarifySlot }
  | { readonly agent_intent: 'ref_ordinal'; readonly ordinal: number }
  | {
      readonly agent_intent: 'refine';
      readonly conditions: {
        readonly platform?: Platform;
        readonly price_min_fen?: number;
        readonly price_max_fen?: number;
      };
    }
  | {
      readonly agent_intent:
        'order_query' | 'rule_qa' | 'out_of_scope' | 'search' | 'find_by_link' | 'handoff';
    };

export type ParsedIntent =
  { readonly kind: 'none' } | { readonly kind: 'intent'; readonly value: IntentOutput };
export type IntentRequest = PathInput & { readonly text: string };

export interface GuideRouteMetadata {
  readonly agent_guide?: boolean;
  readonly agent_guide_account?: 'phone' | 'delete' | 'fund' | null;
}

/** Trusted, run-scoped summaries of actual tool calls, never model-supplied facts. Cards have
 * already been delivered by the tool path; the intent port must not emit them a second time.
 * Failed calls still suppress model text. Empty orders use order_list.empty; empty rules use
 * agent.rule.not_found. The tool path owns order/rule/handoff/earnings card assembly.
 */
export type TemplateCall =
  | {
      readonly name: 'list_my_orders' | 'explain_order';
      readonly orders: readonly {
        readonly reason_code: OrderReason | null;
        readonly display_status: DisplayStatus;
      }[];
    }
  | { readonly name: 'search_rules'; readonly matched: boolean }
  | { readonly name: 'get_my_earnings'; readonly status: 'shown' | 'unavailable' };

export interface IntentTrace {
  readonly intent: string | null;
  readonly text_replaced_by_template: boolean;
  readonly page_guide_reject_reason: PageGuideRejectReason | null;
}

export interface ClarificationScope {
  readonly appId: string;
  readonly sessionId: string;
  readonly chainId: string;
}

export interface IntentDeps {
  readonly routes: {
    configured(appId: string): Promise<readonly string[]>;
    contract(): Readonly<Record<string, GuideRouteMetadata>>;
  };
  readonly flags: {
    enabled(appId: string, key: string): Promise<boolean>;
  };
  readonly tools: { registered(name: string): boolean };
  readonly texts: { text(appId: string, key: string): Promise<string> };
  readonly trace: {
    calls(appId: string, runId: string): Promise<readonly TemplateCall[]>;
    record(appId: string, runId: string, value: IntentTrace): void;
  };
  readonly clarification: {
    /** Resolve the current server-owned result-set chain; never accept a model-supplied id. */
    scope(request: PathInput): Promise<ClarificationScope>;
    /** Atomically consume the one question for this chain/slot. false means already asked. */
    takeOnce(scope: ClarificationScope, slot: ClarifySlot): Promise<boolean>;
    options(
      slot: ClarifySlot,
    ): Promise<
      readonly [
        SuggestionsData['items'][number],
        SuggestionsData['items'][number],
        SuggestionsData['items'][number],
      ]
    >;
    latestProducts(scope: ClarificationScope): Promise<readonly UnnumberedCard[]>;
    /** Server-assembled notice: first product selected / unrecognized condition discarded. */
    fallbackNotice(appId: string, slot: ClarifySlot): Promise<UnnumberedCard>;
    withoutCondition(
      slot: 'price' | 'platform',
      request: IntentRequest,
      ctx: RunContext,
    ): Promise<RunBodyResult>;
  };
  /** Handoff to the tool/refinement path; this port never executes a business tool itself.
   * Also supplies preceding order context for elliptical questions such as 那返了吗. */
  readonly continuation: {
    previousIntent(request: PathInput): Promise<'order_query' | 'earnings_query' | null>;
    run(intent: IntentOutput, request: IntentRequest, ctx: RunContext): Promise<RunBodyResult>;
  };
}
