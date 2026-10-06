// BR-PROD-11: the item_ref product reference token. Issued for every product entry the server
// hands out; verified on convert as the BR-PROD-05 step-① raw-ID source. Never used for
// attribution, never logged in clear, never parsed by clients.
import { FieldCryptoError, type FieldCrypto } from '../../platform/index.ts';
import { isPlatform } from '../../union/index.ts';
import { CatalogError } from '../domain/rules.ts';
import type { RequestRawRef } from '../domain/types.ts';

/** BR-PROD-11: receipt time comes from the upstream response, never from issuance time. */
export interface ItemRefClaims {
  readonly appId: string;
  readonly platform: RequestRawRef['platform'];
  readonly productKey: string;
  readonly rawItemId: string;
  readonly fetchedAt: string;
}

export interface ItemRefRequest {
  readonly itemRef?: string | null;
  readonly appId: string;
  readonly productKey: string;
}

export interface ItemRefOptions {
  readonly crypto: Pick<FieldCrypto, 'encrypt' | 'decrypt'>;
}

export interface ItemRefService {
  /**
   * Technical wire choice: FieldCrypto ciphertext, context `catalog.item_ref`, JSON containing
   * exactly app_id, platform, product_key, raw_item_id and fetched_at. No user/attribution data.
   * Authenticated encryption supplies both confidentiality and tamper detection using the
   * existing field keyring. This is opaque to every client; no separate signing key is needed.
   */
  issue(claims: ItemRefClaims): string;
  /**
   * Absent, unauthenticated, undecodable or foreign-app input returns null. Check app scope
   * before comparing product keys; an authenticated same-app mismatch throws code 20001.
   * Success preserves the receipt time and returns source=item_ref for Catalog.takeRawItemId;
   * that existing selector applies BR-PROD-05's 1800-second limit. This is not attribution.
   */
  verify(request: ItemRefRequest): RequestRawRef | null;
}

/** FieldCrypto context: binds the ciphertext to this use, so other encrypted fields never pass. */
const ITEM_REF_CONTEXT = 'catalog.item_ref';

const FIELDS = ['app_id', 'platform', 'product_key', 'raw_item_id', 'fetched_at'] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isInstant(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

/** Decoded payload → claims, or null when it is not exactly a complete, well-typed reference. */
function parseClaims(plaintext: string): ItemRefClaims | null {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== FIELDS.length || !FIELDS.every((field) => Object.hasOwn(record, field))) {
    return null;
  }
  const {
    app_id: appId,
    platform,
    product_key: productKey,
    raw_item_id: rawItemId,
    fetched_at: fetchedAt,
  } = record;
  if (
    !isNonEmptyString(appId) ||
    !isPlatform(platform) ||
    !isNonEmptyString(productKey) ||
    !isNonEmptyString(rawItemId) ||
    !isInstant(fetchedAt)
  ) {
    return null;
  }
  return { appId, platform, productKey, rawItemId, fetchedAt };
}

/** Implementation phase exports this factory and its types from catalog/index.ts. */
export function createItemRefService(options: ItemRefOptions): ItemRefService {
  const { crypto } = options;

  function issue(claims: ItemRefClaims): string {
    // Pick the five fields explicitly: callers may pass wider objects (user, pid, relation)
    // and none of that may end up in the token.
    const payload = {
      app_id: claims.appId,
      platform: claims.platform,
      product_key: claims.productKey,
      raw_item_id: claims.rawItemId,
      fetched_at: claims.fetchedAt,
    };
    if (parseClaims(JSON.stringify(payload)) === null) {
      // No field values in the message: the raw ID must not reach logs or error output.
      throw new TypeError('item_ref claims are incomplete or malformed');
    }
    return crypto.encrypt(JSON.stringify(payload), ITEM_REF_CONTEXT);
  }

  function open(itemRef: string): ItemRefClaims | null {
    let plaintext: string;
    try {
      plaintext = crypto.decrypt(itemRef, ITEM_REF_CONTEXT);
    } catch (error) {
      // Malformed, unknown key version, wrong key, wrong context or altered: ignore the token.
      if (error instanceof FieldCryptoError) return null;
      throw error;
    }
    return parseClaims(plaintext);
  }

  function verify(request: ItemRefRequest): RequestRawRef | null {
    const { itemRef } = request;
    if (!isNonEmptyString(itemRef)) return null;
    const claims = open(itemRef);
    if (claims === null) return null;
    // App scope first: a foreign app's token is ignored without revealing what it refers to.
    if (claims.appId !== request.appId) return null;
    if (claims.productKey !== request.productKey) {
      throw new CatalogError(20001, 'item_ref does not match the requested product');
    }
    return {
      appId: claims.appId,
      platform: claims.platform,
      productKey: claims.productKey,
      rawItemId: claims.rawItemId,
      fetchedAt: claims.fetchedAt,
      source: 'item_ref',
    };
  }

  return { issue, verify };
}
