import type { OrderSourceMatch } from './source-backfill.ts';

/** B1-08p 编排补充口径 4：在既有回填函数之外判定是否保留四列 NULL。 */
export interface DeferOrderSourceInput {
  readonly source: OrderSourceMatch;
  readonly incomingShopId: string | null | undefined;
  readonly currentShopId: string | null;
  readonly pidScene: string | null;
}

export function shouldDeferOrderSource(input: DeferOrderSourceInput): boolean {
  void input;
  throw new Error('NotImplemented: shouldDeferOrderSource');
}
