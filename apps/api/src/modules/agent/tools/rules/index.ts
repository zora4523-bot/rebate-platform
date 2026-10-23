import type { ToolCallContext, ToolHandler } from '../registry/index.ts';

export interface RuleChunkRow {
  chunk_id: string;
  article_id: string;
  published_version: number;
  title: string;
  text: string;
}

export interface RulesDeps {
  activeChunks(appId: string): Promise<readonly RuleChunkRow[]>;
  config(appId: string, key: 'agent.rag.min_score'): Promise<unknown>;
  texts?(appId: string, key: string): Promise<string>;
  cardReference?(ctx: ToolCallContext, index: number): string;
}

export function scoreRule(question: string, chunk: { title: string; text: string }): number {
  void question;
  void chunk;
  throw new Error('NotImplemented: scoreRule');
}

export function createSearchRulesHandler(deps: RulesDeps): ToolHandler {
  void deps;
  throw new Error('NotImplemented: createSearchRulesHandler');
}
