import type { ClaimEntryReader } from '../../../linking/index.ts';
import type { Clock } from '../../../platform/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolCallContext, ToolHandler } from '../registry/index.ts';

/** B3-08d: read-only draft preparation; no order lookup or claim submission port. */
export interface ClaimDraftDeps {
  readonly clicks: Pick<ClaimEntryReader, 'read'>;
  readonly clock: Clock;
  readonly config: (appId: string, key: string) => Promise<unknown>;
  readonly platforms: readonly string[];
  readonly cardReference?: (ctx: ToolCallContext, index: number) => string;
  readonly texts?: (appId: string, key: string) => Promise<string>;
}

export function createPrefillClaimHandler(deps: ClaimDraftDeps): ToolHandler {
  void deps;
  throw new Error('NotImplemented: createPrefillClaimHandler');
}

/** Shared card builder for prefill_claim and explain_order's independently decided miss. */
export function claimDraftCard(
  deps: ClaimDraftDeps,
  ctx: ToolCallContext,
  input: { readonly platform: string; readonly orderNo: string },
): Promise<UnnumberedCard> {
  void deps;
  void ctx;
  void input;
  throw new Error('NotImplemented: claimDraftCard');
}
