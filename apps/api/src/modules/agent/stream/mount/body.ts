import type { RunBodyInput } from '../../http/index.ts';
import type { AgentRunBodyDeps, ToolTraceFragment } from '../../orchestrator/core/ports.ts';
import type { RunBody } from '../run/index.ts';

/** Shared assembly seam for stream production and local evaluations. Factories, limits,
 * text handling and trace masking have one owner; callers supply infrastructure ports.
 */
export interface AgentBodyAssemblyDeps extends Omit<
  AgentRunBodyDeps,
  'degraded' | 'limits' | 'traceMask'
> {
  errorMsg(appId: string, code: number): Promise<string>;
  onTrace?: (fragment: ToolTraceFragment) => void;
}

export interface AgentBodyAssembly {
  body(input: RunBodyInput): RunBody;
  traceMask(args: unknown, placeholders: Readonly<Record<string, string>>): unknown;
}

export function createAgentBodyAssembly(deps: AgentBodyAssemblyDeps): AgentBodyAssembly {
  void deps;
  throw new Error('NotImplemented: createAgentBodyAssembly');
}
