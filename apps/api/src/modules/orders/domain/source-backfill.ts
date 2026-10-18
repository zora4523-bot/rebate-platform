import type { RegisteredPlatform, UnionOrderAttrParams } from '../../union/index.ts';

export interface ExactLink {
  readonly link_id: string;
  readonly user_id: string | null;
  readonly scene: string | null;
  readonly agent_session_id: string | null;
}

export interface LinkLogCandidate extends Omit<ExactLink, 'link_id'> {
  readonly link_id: string | null;
  readonly id: bigint;
  readonly event: string;
  readonly platform: string | null;
  readonly product_key: string | null;
  readonly shop_id: string | null;
  readonly pid_scene: string | null;
  readonly result_code: number | null;
  readonly created_at: Date;
}

export interface MatchOrderSourceInput {
  readonly userId: string;
  readonly platform: RegisteredPlatform;
  readonly productKey: string | null;
  readonly shopId: string | null;
  readonly pidScene: string;
  readonly attrAt: Date;
  readonly windowHours: number;
  readonly exactLink: ExactLink | null;
  readonly candidates: readonly LinkLogCandidate[];
}

export interface OrderSourceMatch {
  readonly source_match: 'exact' | 'product' | 'shop' | 'none';
  readonly link_id: string | null;
  readonly source_scene: string | null;
  readonly agent_session_id: string | null;
}

export function matchOrderSource(input: MatchOrderSourceInput): OrderSourceMatch {
  void input;
  throw new Error('NotImplemented: matchOrderSource');
}

export function parseLinkCode(
  platform: RegisteredPlatform,
  attrParams: UnionOrderAttrParams,
): string | null {
  void platform;
  void attrParams;
  throw new Error('NotImplemented: parseLinkCode');
}
