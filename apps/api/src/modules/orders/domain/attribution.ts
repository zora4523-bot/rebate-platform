import type { RegisteredPlatform, UnionOrderAttrParams } from '../../union/index.ts';

export interface BindingRow {
  readonly user_id: string;
  readonly bound_at: Date | null;
  readonly released_at: Date | null;
  readonly cooldown_until: Date | null;
}

export type BindingDecision =
  | { readonly kind: 'matched'; readonly user_id: string }
  | { readonly kind: 'miss' | 'conflict'; readonly user_id: null };

export interface BuyTypeDecision {
  readonly buy_type: 'self' | 'share';
  readonly scene_basis: 'pid' | 'param' | 'fallback';
}

export function parseAttrCode(
  platform: RegisteredPlatform,
  params: UnionOrderAttrParams,
): string | null {
  void platform;
  void params;
  throw new Error('NotImplemented: parseAttrCode');
}

export function resolveBinding(rows: readonly BindingRow[], attrAt: Date): BindingDecision {
  void rows;
  void attrAt;
  throw new Error('NotImplemented: resolveBinding');
}

export function classifyBuyType(
  platform: RegisteredPlatform,
  pidScene: string,
  customParameters: string | null,
): BuyTypeDecision {
  void platform;
  void pidScene;
  void customParameters;
  throw new Error('NotImplemented: classifyBuyType');
}
