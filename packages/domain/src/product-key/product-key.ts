// product_key derivation, validation and splitting (规划/08 BR-PROD-02, BR-PROD-03).
//
// Pure functions: no database, configuration or clock reads. The key_prefix (platforms
// table) and the JD mode (config product_key.jd.mode) are supplied by the caller; no
// platform prefix enumeration is hard-coded here. Aliases (resolveProductKey), the fallback
// key (BR-PROD-06) and order-side persistence are out of scope.

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

/** BR-PROD-03 derivation failure; code is the contract-level string PRODUCT_KEY_UNDERIVABLE. */
export class ProductKeyUnderivable extends Error {
  readonly code = 'PRODUCT_KEY_UNDERIVABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ProductKeyUnderivable';
  }
}

/** BR-PROD-02 parameter error: 20001 with data.fields=['product_key']. */
export class ProductKeyInvalid extends Error {
  readonly code = 20001 as const;
  readonly data: { readonly fields: readonly ['product_key'] } = { fields: ['product_key'] };
  constructor(message: string) {
    super(message);
    this.name = 'ProductKeyInvalid';
  }
}

/** BR-PROD-02 step 4 / BR-PROD-10: both parse and search disabled for the prefix's platform. */
export class ProductKeyPlatformUnsupported extends Error {
  readonly code = 30131 as const;
  constructor(message: string) {
    super(message);
    this.name = 'ProductKeyPlatformUnsupported';
  }
}

// BR-PROD-02 细则: group 1 lowercase 2–3 letters; stable_id 1–124 chars of 0x21–0x7E minus # / ?.
const PRODUCT_KEY_RE = /^([a-z]{2,3}):([\x21\x22\x24-\x2E\x30-\x3E\x40-\x7E]{1,124})$/;
const KEY_PREFIX_RE = /^[a-z]{2,3}$/;
const STABLE_ID_RE = /^[\x21\x22\x24-\x2E\x30-\x3E\x40-\x7E]{1,124}$/;

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Returns the stable_id per BR-PROD-03, or undefined when the selected rule yields nothing. */
function stableIdOf(
  config: ProductKeyDerivation,
  payload: UnionProductPayload,
): string | undefined {
  switch (config.platform) {
    case 'taobao': {
      const raw = nonEmpty(payload.item_id);
      if (raw === undefined) return undefined;
      const segments = raw.split('-');
      return segments[segments.length - 1];
    }
    case 'jd': {
      if (config.jdMode === 'sku') return nonEmpty(payload.skuId);
      // Absent means item; any other runtime value is a misconfiguration and fails closed.
      if (config.jdMode !== undefined && config.jdMode !== 'item') return undefined;
      const raw = nonEmpty(payload.itemId);
      if (raw === undefined) return undefined;
      const second = raw.split('_')[1];
      return second === undefined || second === '' ? undefined : `i_${second}`;
    }
    case 'pdd':
      // goods_sign is only raw_item_id; it never enters the key.
      return nonEmpty(payload.goods_id);
    default:
      // Platforms without a BR-PROD-03 rule (including tmall, which is platform=taobao).
      return undefined;
  }
}

/**
 * BR-PROD-03: the single derivation of product_key. Failure throws ProductKeyUnderivable
 * (code='PRODUCT_KEY_UNDERIVABLE'); results are never truncated, escaped or trimmed.
 */
export function deriveProductKey(
  platform: ProductKeyDerivation,
  unionPayload: UnionProductPayload,
): string {
  const prefix = platform.keyPrefix;
  if (typeof prefix !== 'string' || !KEY_PREFIX_RE.test(prefix)) {
    throw new ProductKeyUnderivable(`no usable key_prefix for platform ${platform.platform}`);
  }
  const stableId = stableIdOf(platform, unionPayload);
  if (stableId === undefined || !STABLE_ID_RE.test(stableId)) {
    throw new ProductKeyUnderivable(`stable_id not derivable for platform ${platform.platform}`);
  }
  return `${prefix}:${stableId}`;
}

/** Shared BR-PROD-02 validation in the order ① format ② prefix ③ platform ④ capabilities. */
function check(
  key: unknown,
  platforms: readonly ProductKeyPlatform[],
  requestedPlatform: string | undefined,
): ProductKeyParts {
  if (typeof key !== 'string') throw new ProductKeyInvalid('product_key must be a string');
  const match = PRODUCT_KEY_RE.exec(key);
  if (match === null) throw new ProductKeyInvalid('product_key format invalid');
  const keyPrefix = match[1] as string;
  const stableId = match[2] as string;
  const row = platforms.find((candidate) => candidate.keyPrefix === keyPrefix);
  if (row === undefined) throw new ProductKeyInvalid('product_key prefix not registered');
  if (requestedPlatform !== undefined && requestedPlatform !== row.platform) {
    throw new ProductKeyInvalid('product_key prefix does not match platform');
  }
  if (!row.parseEnabled && !row.searchEnabled) {
    throw new ProductKeyPlatformUnsupported(`platform ${row.platform} parse and search disabled`);
  }
  return { platform: row.platform, keyPrefix, stableId };
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
  check(key, platforms, requestedPlatform);
}

/** Same validation as validateProductKey, then split at the first colon only. */
export function splitProductKey(
  key: unknown,
  platforms: readonly ProductKeyPlatform[],
  requestedPlatform?: string,
): ProductKeyParts {
  return check(key, platforms, requestedPlatform);
}
