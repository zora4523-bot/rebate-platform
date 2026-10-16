import type { AgentRunTexts, DegradedPath, OrchestratorTools } from '../core/ports.ts';

export interface DegradedPathDeps {
  readonly tools: Pick<OrchestratorTools, 'enabledSearchPlatforms' | 'searchKeyword'>;
  readonly texts: Pick<AgentRunTexts, 'text'>;
  readonly errorMsg: (appId: string, code: number) => Promise<string>;
}

/** BR-AI-14: plan from proceed.modelText, using the B3-02d planner/outcome functions.
 * Forward tool cards through ctx.card; empty outcomes emit an agent.degraded.empty notice.
 * An absent platform result throws; abort suppresses subsequent output after every await.
 * All-platform failure maps to error 50302, fallback=search_page, fallback_q=plan.q.
 */
export function createDegradedPath(deps: DegradedPathDeps): DegradedPath {
  void deps;
  throw new Error('NotImplemented: createDegradedPath');
}
