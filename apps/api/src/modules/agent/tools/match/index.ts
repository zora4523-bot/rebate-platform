import type { Scheduler } from '../../../platform/index.ts';
import type { AgentProductCard } from '../search/card.ts';

export interface MatchableCard {
  readonly title: string | null;
  readonly final_price_fen: number;
  readonly match_tag: AgentProductCard['match_tag'];
  readonly spec_text: string | null;
  readonly benefit_tags: readonly string[];
  readonly coupon_fen: number;
  readonly is_presale: boolean;
}

/** B3-05g 提供用户原始条件及本轮是否已经放宽。 */
export interface MatchConditions {
  readonly spec?: string;
  readonly priceMinFen?: number;
  readonly priceMaxFen?: number;
  readonly relaxed: boolean;
}

export interface ResultCheckPort {
  check(
    items: readonly { title: string }[],
    need: { spec?: string },
    signal: AbortSignal,
  ): Promise<readonly ('consistent' | 'inconsistent' | 'unsure')[]>;
}

export interface MatchDeps {
  provider(appId: string): Promise<'rules' | 'jev'>;
  readonly resultCheck?: ResultCheckPort;
  readonly timeoutMs?: () => number;
  readonly scheduler: Scheduler;
}

/** BR-AI-24 按优先级判定；保持卡片数量、顺序和其余字段，不修改入参。 */
export async function assignMatchTags<T extends MatchableCard>(
  cards: readonly T[],
  conditions: MatchConditions,
  appId: string,
  deps: MatchDeps,
): Promise<readonly T[]> {
  void cards;
  void conditions;
  void appId;
  void deps;
  throw new Error('NotImplemented: assignMatchTags');
}

export function agentBenefitTags(card: MatchableCard): readonly string[] {
  void card;
  throw new Error('NotImplemented: agentBenefitTags');
}
