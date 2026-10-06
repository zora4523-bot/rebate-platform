import type { FieldCrypto } from '../../platform/index.ts';
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

/** Implementation phase exports this factory and its types from catalog/index.ts. */
export function createItemRefService(options: ItemRefOptions): ItemRefService {
  void options;
  throw new Error('NotImplemented: createItemRefService');
}
