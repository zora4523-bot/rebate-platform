// B3-03p · BR-AI-05 / BR-AI-14: the no-model keyword search's result sets. The search decorator
// forwards searchKeyword unchanged (B3-05g); the production assembly calls this after the keyword
// search returns, so each product_list it built has its result set (the plan's conditions, server
// side) before any card is written — the receipt store records deliveries only under a saved set.
import type { KeywordSearchPlan } from '../../model-gateway/degraded/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolContext } from '../core/ports.ts';
import { conditionsOf, newChainId, setChain } from './shared.ts';
import type { ResultSetStore } from './types.ts';

/**
 * Saves every product_list's result_set_id under the run's app, session and run with the plan's
 * conditions (q, platforms, relevance, page 1) on a new chain, which becomes the session's current
 * chain (换一批 continues from what was shown). Nothing is saved without a product_list.
 */
export async function saveKeywordResults(
  store: ResultSetStore,
  plan: KeywordSearchPlan,
  ctx: ToolContext,
  cards: readonly UnnumberedCard[],
): Promise<void> {
  const ids: string[] = [];
  for (const card of cards) {
    const id = card.data['result_set_id'];
    if (card.type === 'product_list' && typeof id === 'string' && id !== '') ids.push(id);
  }
  if (ids.length === 0) return;
  const chainId = newChainId();
  const conditions = conditionsOf(
    { q: plan.q, platforms: [...plan.platforms], sort: plan.sort, page: 1 },
    chainId,
  );
  if (conditions === null) return;
  const appId = ctx.subject.appId;
  for (const id of ids) {
    await store.save({ id, appId, sessionId: ctx.sessionId, runId: ctx.runId, conditions });
  }
  await setChain(store, appId, ctx.sessionId, { chainId, conditions, status: 'has_products' });
}
