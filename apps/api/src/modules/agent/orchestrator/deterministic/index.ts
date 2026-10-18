import type { LinkQuoteRunner } from '../../tools/quote/index.ts';
import type { AgentRunTexts, DeterministicPath, ToolTraceFragment } from '../core/ports.ts';

export interface DeterministicPathDeps {
  readonly quotes: LinkQuoteRunner;
  readonly texts: AgentRunTexts;
  readonly onTrace?: (fragment: ToolTraceFragment) => void;
}

export function createDeterministicPath(deps: DeterministicPathDeps): DeterministicPath {
  void deps;
  throw new Error('NotImplemented: createDeterministicPath');
}
