// B1-06k: application-stage boundary, not an HTTP response. Amounts retain B1-06d's
// lossless decimal-string representation; the later HTTP adapter owns wire serialization.
import type { components } from '@couli/contracts-ts';
import type { AssembleCardInput, CatalogCardEntry } from '../../catalog/index.ts';
import type { Idempotency } from '../../platform/index.ts';
import type { LinkOpenOwnerOptions, LinkOpenOwnerResult } from './link-open-owner.ts';

export type LinkOpenJump = components['schemas']['JumpPlan'];

/** Only normalized catalog input, never fabricated platform payloads. */
export type LinkOpenPrice =
  | { readonly kind: 'off_shelf' }
  | { readonly kind: 'tlj_empty' }
  | { readonly kind: 'available'; readonly input: AssembleCardInput };

export interface LinkOpenCacheKey {
  readonly appId: string;
  /** The frozen identity's owner, not necessarily the opener or links.user_id. */
  readonly userId: string | null;
  readonly platform: string;
  readonly productKey: string | null;
  readonly rawItemId: string | null;
  readonly pid: string | null;
  readonly pidScene: string;
  readonly noRebate: boolean;
}

export interface LinkOpenCachedJump {
  readonly jump: LinkOpenJump;
  readonly fetchedAt: string;
}

export interface LinkOpenConversionInput {
  readonly owner: LinkOpenOwnerResult;
  readonly noRebate: boolean;
  readonly installed: components['schemas']['OpenLinkRequest']['installed'];
}

export interface LinkOpenRequoteOptions extends LinkOpenOwnerOptions {
  readonly catalog: CatalogCardEntry;
  readonly prices: { fetch(owner: LinkOpenOwnerResult): Promise<LinkOpenPrice> };
  readonly conversion: { convert(input: LinkOpenConversionInput): Promise<LinkOpenJump> };
  readonly cache: {
    get(key: LinkOpenCacheKey): Promise<LinkOpenCachedJump | null>;
    put(key: LinkOpenCacheKey, value: LinkOpenCachedJump): Promise<void>;
  };
  readonly idempotency: Pick<Idempotency, 'execute'>;
  // TODO(规划/11 §4.5): 拼多多比价预判开关打开的分支 — blocked on CAP-PDD-04。
}

export interface LinkOpenRequoteInput {
  readonly linkId: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
  /** Server-resolved client; not copied from an untrusted body. */
  readonly client: 'ios' | 'android' | 'harmony' | 'h5' | 'web';
  readonly installed?: components['schemas']['OpenLinkRequest']['installed'];
  readonly noRebate?: boolean;
}

export type LinkOpenRequoteResult = Omit<
  components['schemas']['OpenLinkResult'],
  'old_final_price_fen' | 'new_final_price_fen' | 'new_rebate_min_fen' | 'new_rebate_max_fen'
> & {
  readonly old_final_price_fen: string | null;
  readonly new_final_price_fen: string | null;
  readonly new_rebate_min_fen: string | null;
  readonly new_rebate_max_fen: string | null;
};

export type LinkOpenRequoteOutcome =
  | { readonly code: 0; readonly data: LinkOpenRequoteResult }
  | { readonly code: number; readonly data: null };

export interface LinkOpenRequoteService {
  open(input: LinkOpenRequoteInput): Promise<LinkOpenRequoteOutcome>;
}

export function createLinkOpenRequote(options: LinkOpenRequoteOptions): LinkOpenRequoteService {
  void options;
  throw new Error('NotImplemented: createLinkOpenRequote');
}
