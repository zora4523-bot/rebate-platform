import { vi } from 'vitest';
import type {
  MatchableCard,
  MatchDeps,
  ResultCheckPort,
} from '../../../../apps/api/src/modules/agent/tools/match/index.ts';
import { ManualScheduler } from '../../platform/http/kit.ts';

export { ManualScheduler, flush, observe } from '../../platform/http/kit.ts';

export interface TestCard extends MatchableCard {
  readonly product_key: string;
  readonly price_fen: number;
  readonly est_net_price_fen: number;
  readonly link_id: string;
}

export function card(patch: Partial<TestCard> = {}): TestCard {
  return {
    product_key: 'tb:synthetic-match',
    title: '合成纯牛奶24盒',
    final_price_fen: 4500,
    price_fen: 9000,
    est_net_price_fen: 1000,
    coupon_fen: 0,
    is_presale: false,
    match_tag: 'matched',
    spec_text: null,
    benefit_tags: [],
    link_id: 'synthetic-link',
    ...patch,
  };
}

export function fixture(mode: 'rules' | 'jev' = 'rules') {
  const scheduler = new ManualScheduler();
  const provider = vi.fn<MatchDeps['provider']>().mockResolvedValue(mode);
  const check = vi
    .fn<ResultCheckPort['check']>()
    .mockImplementation(async (items) => items.map(() => 'consistent'));
  const deps: MatchDeps = { provider, resultCheck: { check }, scheduler };
  return { scheduler, provider, check, deps };
}

export function labels(cards: readonly MatchableCard[]) {
  return cards.map(({ match_tag, spec_text }) => ({ match_tag, spec_text }));
}
