import type { ToolContext } from './ports.ts';

/** Shared structural context accepted by both ToolContext and registry ToolCallContext. */
export type CardReferenceContext = Pick<
  ToolContext,
  'runId' | 'sessionId' | 'signal' | 'placeholders'
>;

/**
 * B3-05i / BR-AI-05: tools inject this function as deps.cardReference(ctx, index).
 * index addresses outcome.cards, not embedded products or the session sequence.
 * An issued reference is opaque, scoped to one execute call, and never a real cN id.
 * Wire format: @card-ref:<nonce>:<encodeURIComponent(callId)>:<index>, where nonce is
 * 32 lowercase hex characters from server-side cryptographic randomness for this call.
 * Only issued tokens may be resolved (a matching string pattern is insufficient).
 * Core resolves whole string values recursively after confirmed card delivery, removing
 * object fields / array elements for undelivered cards, before model or trace exposure.
 * No-reference modelView and failed / rejected outcomes retain their existing behavior.
 */
export function cardReference(ctx: CardReferenceContext, index: number): string {
  void ctx;
  void index;
  throw new Error('NotImplemented: cardReference');
}
