import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import type {
  ItemRefClaims,
  ItemRefOptions,
  ItemRefService,
} from '../../../../apps/api/src/modules/catalog/application/item-ref.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';

export const CONTEXT = 'catalog.item_ref';
export const RECEIVED_AT = '2026-10-06T03:04:05.123Z';

export function claims(overrides: Partial<ItemRefClaims> = {}): ItemRefClaims {
  return {
    appId: 'app-item-ref-a',
    platform: 'taobao',
    productKey: 'tb:AbC001',
    rawItemId: 'demo-prefix-000123-AbC001',
    fetchedAt: RECEIVED_AT,
    ...overrides,
  };
}

export function payload(value: ItemRefClaims) {
  return {
    app_id: value.appId,
    platform: value.platform,
    product_key: value.productKey,
    raw_item_id: value.rawItemId,
    fetched_at: value.fetchedAt,
  };
}

export function publicFactory(): (options: ItemRefOptions) => ItemRefService {
  // No runtime import of the skeleton: every observation goes through catalog/index.ts.
  // Until implementation adds the export, fail an assertion rather than calling undefined.
  const exported = catalog as unknown as Record<string, unknown>;
  expect(exported['createItemRefService'], 'catalog public item_ref factory').toBeTypeOf(
    'function',
  );
  return exported['createItemRefService'] as (options: ItemRefOptions) => ItemRefService;
}

export async function fixture() {
  const create = publicFactory();
  const provider = new LocalKeyProvider(randomBytes(32));
  const keyring = await createWrappedKeyring(provider);
  const crypto = await openFieldCrypto(keyring, provider);
  return { create, provider, keyring, crypto, service: create({ crypto }) };
}

/** Mutate a decoded byte, then re-encode canonically: failure must be authentication failure. */
export function corrupt(ciphertext: string, part: 'iv' | 'body' | 'tag'): string {
  const [format, version, encoded] = ciphertext.split('.');
  expect(format).toBe('v1');
  expect(encoded).toBeTypeOf('string');
  const bytes = Buffer.from(encoded!, 'base64url');
  const offset = part === 'iv' ? 0 : part === 'body' ? 12 : bytes.length - 1;
  bytes[offset] = bytes[offset]! ^ 1;
  return `${format}.${version}.${bytes.toString('base64url')}`;
}
