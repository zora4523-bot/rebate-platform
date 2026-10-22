// B3-03j: production composition contract. No model transport or review service is added here.
// The implementation composes registry + keyword search + results/match, shares one result store
// with references/clarification/refinement, and binds parsing.parseUrl AND parsing.parseToken.
// Token candidates must reach the same quote runner (the older deterministic path skips them).
// Card entry creation is per call: linking receives scene=agent and the authenticated session.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { CatalogCardEntry, CatalogConfigReader } from '../../../catalog/index.ts';
import type { ParsingOptions } from '../../../parsing/index.ts';
import type { Clock, RootLogger, Scheduler } from '../../../platform/index.ts';
import type {
  AgentRunTexts,
  DeterministicPath,
  IntentPort,
  OrchestratorTools,
} from '../../orchestrator/index.ts';
import type { IntentDeps } from '../../orchestrator/intents/index.ts';
import type { ResultSetStore } from '../../orchestrator/results/index.ts';
import type { RebateQuoteDeps } from '../../tools/quote/index.ts';
import type { ToolCallContext } from '../../tools/registry/index.ts';
import type { SearchProductsDeps } from '../../tools/search/index.ts';

export interface AgentStreamAssemblyContext {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
}

export interface AgentStreamBusinessPorts {
  readonly search: Pick<
    SearchProductsDeps,
    'platforms' | 'searchProducts' | 'prohibited' | 'categoryAllowed'
  >;
  readonly readProduct: RebateQuoteDeps['catalog']['readProduct'];
  readonly parsing: ParsingOptions;
  readonly cards: (
    context: ToolCallContext,
    registration: { readonly scene: 'agent'; readonly agentSessionId: string },
  ) => CatalogCardEntry;
}

export interface AgentStreamAssemblyDeps extends AgentStreamAssemblyContext {
  readonly ports: AgentStreamBusinessPorts;
  readonly config: CatalogConfigReader;
  readonly scheduler: Scheduler;
  readonly texts: AgentRunTexts;
  readonly routes: IntentDeps['routes'];
}

export interface AgentStreamAssembly {
  readonly tools: OrchestratorTools;
  readonly deterministic: DeterministicPath;
  readonly intents: IntentPort;
  readonly results: ResultSetStore;
  readonly texts: AgentRunTexts;
}

/** Optional on the module/runtime: absence preserves B3-03f's minimal mount. */
export type AgentStreamAssemblyFactory = (
  context: AgentStreamAssemblyContext,
) => AgentStreamAssembly;

export function createAgentStreamAssembly(deps: AgentStreamAssemblyDeps): AgentStreamAssembly {
  void deps;
  throw new Error('NotImplemented: createAgentStreamAssembly');
}
