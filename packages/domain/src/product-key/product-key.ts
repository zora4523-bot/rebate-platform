/** Caller-supplied platforms row; no database or configuration reads in this package. */
export interface ProductKeyPlatform {
  readonly platform: string;
  readonly keyPrefix: string | null;
  readonly parseEnabled: boolean;
  readonly searchEnabled: boolean;
}

/** Prefix comes from platforms; jdMode comes from product_key.jd.mode (absent means item). */
export interface ProductKeyDerivation {
  readonly platform: string;
  readonly keyPrefix: string | null;
  readonly jdMode?: 'item' | 'sku';
}

/** Normalized ID fields, not a vendor wire format. Adapters preserve IDs as strings. */
export interface UnionProductPayload {
  readonly item_id?: string | null;
  readonly itemId?: string | null;
  readonly skuId?: string | null;
  readonly goods_id?: string | null;
  readonly goods_sign?: string | null;
}

export interface ProductKeyParts {
  readonly platform: string;
  readonly keyPrefix: string;
  readonly stableId: string;
}

/** BR-PROD-03: failure throws an Error with code='PRODUCT_KEY_UNDERIVABLE'. */
export function deriveProductKey(
  platform: ProductKeyDerivation,
  unionPayload: UnionProductPayload,
): string {
  void platform;
  void unionPayload;
  throw new Error('NotImplemented: deriveProductKey');
}

/**
 * BR-PROD-02: format -> prefix lookup -> optional platform match -> capabilities.
 * Invalid input throws Error with code=20001, data.fields=['product_key'];
 * both capabilities disabled throws Error with code=30131 (contracts/error-codes.yaml).
 * No aliases, URL decoding, case folding or trimming here.
 */
export function validateProductKey(
  key: unknown,
  platforms: readonly ProductKeyPlatform[],
  requestedPlatform?: string,
): void {
  void key;
  void platforms;
  void requestedPlatform;
  throw new Error('NotImplemented: validateProductKey');
}

/** Same validation as validateProductKey, then split at the first colon only. */
export function splitProductKey(
  key: unknown,
  platforms: readonly ProductKeyPlatform[],
  requestedPlatform?: string,
): ProductKeyParts {
  void key;
  void platforms;
  void requestedPlatform;
  throw new Error('NotImplemented: splitProductKey');
}
