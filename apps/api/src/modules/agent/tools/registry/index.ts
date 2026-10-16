import type { RootLogger } from '../../../platform/index.ts';
import type { OrchestratorTools, ToolContext, ToolOutcome } from '../../orchestrator/index.ts';

export type ToolDefinition = Awaited<ReturnType<OrchestratorTools['definitions']>>[number];

/** Authenticated subject only; never merge model arguments into this context. */
export interface ToolCallContext extends Pick<
  ToolContext['subject'],
  'appId' | 'userId' | 'deviceId' | 'phoneBound'
> {
  readonly runId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly context?: ToolContext['context'];
  readonly placeholders: Readonly<Record<string, string>>;
}

export interface ToolHandler {
  readonly name: string;
  readonly definition: ToolDefinition;
  readonly audience: 'all' | 'phone_bound';
  run(args: Readonly<Record<string, unknown>>, toolCtx: ToolCallContext): Promise<ToolOutcome>;
}

export interface ToolSwitches {
  /** Only an explicit true enables the tool; unavailable settings fail closed. */
  get(appId: string, key: `agent.tools.${string}.enabled`): Promise<boolean | undefined>;
}

export interface ToolRegistryDeps {
  readonly handlers: readonly ToolHandler[];
  readonly switches: ToolSwitches;
  readonly logger?: Pick<RootLogger, 'warn'>;
}

/** B3-04a: schema validation, decideToolCall, subject filtering and server context injection.
 * JSON parsing and tool_calls trace assembly belong to the existing orchestrator.
 * AgentCaller currently has no scene or promotion fields: do not infer them from args/context.
 * The two keyword fallback methods of OrchestratorTools have no reader in this task.
 */
export function createToolRegistry(deps: ToolRegistryDeps): OrchestratorTools {
  void deps;
  throw new Error('NotImplemented: createToolRegistry');
}

export function registeredToolNames(handlers: readonly ToolHandler[]): readonly string[] {
  void handlers;
  throw new Error('NotImplemented: registeredToolNames');
}
