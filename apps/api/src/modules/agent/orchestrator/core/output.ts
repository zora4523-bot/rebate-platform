// B3-05b: per-run output gate (02 §9.2 「输出上限」「取消与断线」; BR-AI-06 suggestions ≤ 3 per run).
// Every write of the core and of downstream paths goes through one RunOutput, so cancellation
// and the three output caps (text code points, cards incl. embedded products, content frames)
// hold on all paths. Reaching a cap exactly counts as hitting it: nothing is written afterwards.
import type { SuggestionsData } from '../../stream/writer/index.ts';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import type { OrchestratorLimits } from './ports.ts';

const MAX_SUGGESTIONS = 3;

export function codePoints(text: string): number {
  let n = 0;
  for (const ch of text) {
    void ch;
    n += 1;
  }
  return n;
}

/** Embedded product cards, numbered after their container (same rule as numberCard). */
export function embeddedCards(card: UnnumberedCard): number {
  const data: unknown = card.data;
  if (typeof data !== 'object' || data === null) return 0;
  if (card.type === 'product_list') {
    const items = (data as { readonly items?: unknown }).items;
    return Array.isArray(items) ? items.length : 0;
  }
  if (card.type === 'rebate_quote') {
    const product = (data as { readonly product?: unknown }).product;
    return typeof product === 'object' && product !== null ? 1 : 0;
  }
  return 0;
}

export class RunOutput {
  private frames = 0;
  private cards = 0;
  private textUsed = 0;
  private suggestionsSent = 0;
  private hit = false;
  private readonly ctx: RunContext;
  private readonly limits: OrchestratorLimits;

  constructor(ctx: RunContext, limits: OrchestratorLimits) {
    this.ctx = ctx;
    this.limits = limits;
  }

  get limitHit(): boolean {
    return this.hit;
  }

  get aborted(): boolean {
    return this.ctx.signal.aborted;
  }

  private get closed(): boolean {
    return this.hit || this.ctx.signal.aborted;
  }

  /** Content frame room; marks the cap when none is left. */
  private frameRoom(): boolean {
    if (this.frames < this.limits.contentFrames) return true;
    this.hit = true;
    return false;
  }

  private settle(): void {
    if (
      this.frames >= this.limits.contentFrames ||
      this.cards >= this.limits.cards ||
      this.textUsed >= this.limits.textCodePoints
    ) {
      this.hit = true;
    }
  }

  /** True when (a prefix of) the delta was written. */
  text(delta: string): boolean {
    if (this.closed || delta === '' || !this.frameRoom()) return false;
    const room = this.limits.textCodePoints - this.textUsed;
    if (room <= 0) {
      this.hit = true;
      return false;
    }
    const size = codePoints(delta);
    const kept = size > room ? Array.from(delta).slice(0, room).join('') : delta;
    this.ctx.text(kept);
    this.frames += 1;
    this.textUsed += size > room ? room : size;
    if (size > room) this.hit = true;
    this.settle();
    return true;
  }

  /** True when the whole card was written; a card that does not fit is never split. */
  async card(card: UnnumberedCard): Promise<boolean> {
    if (this.closed || !this.frameRoom()) return false;
    const cost = 1 + embeddedCards(card);
    if (this.cards + cost > this.limits.cards) {
      this.hit = true;
      return false;
    }
    this.cards += cost;
    this.frames += 1;
    const written = this.ctx.card(card);
    this.settle();
    await written;
    return true;
  }

  /** BR-AI-06 ≤ 3 per run, across tools and rounds: items beyond the run's room are dropped. */
  suggestions(items: SuggestionsData['items']): boolean {
    const room = MAX_SUGGESTIONS - this.suggestionsSent;
    if (this.closed || items.length === 0 || room <= 0 || !this.frameRoom()) return false;
    const kept = items.slice(0, room);
    this.ctx.suggestions(kept);
    this.suggestionsSent += kept.length;
    this.frames += 1;
    this.settle();
    return true;
  }

  status(tool: string, phase: 'start' | 'end' | 'failed', display: string): void {
    if (this.closed) return;
    this.ctx.toolStatus(tool, phase, display);
  }

  /** The guarded context handed to downstream paths: same signal, same caps. */
  context(): RunContext {
    const ctx = this.ctx;
    return {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
      get cardsDelivered() {
        return ctx.cardsDelivered;
      },
      text: (delta) => {
        this.text(delta);
      },
      toolStatus: (tool, phase, display) => {
        this.status(tool, phase, display);
      },
      card: async (card) => {
        await this.card(card);
      },
      suggestions: (items) => {
        this.suggestions(items);
      },
    };
  }
}
