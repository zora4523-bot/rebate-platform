import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolCallContext, ToolHandler } from '../registry/index.ts';

export interface HandoffDeps {
  texts?(appId: string, key: string): Promise<string>;
  cardReference?(ctx: ToolCallContext, index: number): string;
}

export function createHandoffHandler(deps: HandoffDeps): ToolHandler {
  void deps;
  throw new Error('NotImplemented: createHandoffHandler');
}

export async function handoffCard(deps: HandoffDeps, appId: string): Promise<UnnumberedCard> {
  void deps;
  void appId;
  throw new Error('NotImplemented: handoffCard');
}
