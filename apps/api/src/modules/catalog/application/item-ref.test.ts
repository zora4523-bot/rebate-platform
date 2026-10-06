import { expect, it } from 'vitest';
import { createItemRefService, type ItemRefClaims } from './item-ref.ts';

// A stand-in cipher: only the service's own field handling is under test here.
const crypto = {
  encrypt: (plaintext: string, context: string) => `${context}|${plaintext}`,
  decrypt: (ciphertext: string, context: string) => {
    const prefix = `${context}|`;
    if (!ciphertext.startsWith(prefix)) throw new Error('unexpected cipher input');
    return ciphertext.slice(prefix.length);
  },
};

const claims: ItemRefClaims = {
  appId: 'app-unit',
  platform: 'jd',
  productKey: 'jd:00042',
  rawItemId: 'raw-00042',
  fetchedAt: '2026-10-06T00:00:00.000Z',
};

it('[AC-B1-05h] issue refuses incomplete claims without echoing their values', () => {
  const service = createItemRefService({ crypto });
  for (const bad of [
    { ...claims, rawItemId: '' },
    { ...claims, fetchedAt: 'raw-00042-later' },
    { ...claims, platform: 'unknown' as ItemRefClaims['platform'] },
  ]) {
    expect(() => service.issue(bad)).toThrowError(
      expect.objectContaining({ message: expect.not.stringContaining('raw-00042') }),
    );
  }
});

it('[AC-B1-05h] verify ignores payloads carrying extra fields', () => {
  const service = createItemRefService({ crypto });
  const itemRef = crypto.encrypt(
    JSON.stringify({
      app_id: claims.appId,
      platform: claims.platform,
      product_key: claims.productKey,
      raw_item_id: claims.rawItemId,
      fetched_at: claims.fetchedAt,
      user_id: 'viewer',
    }),
    'catalog.item_ref',
  );
  expect(
    service.verify({ appId: claims.appId, productKey: claims.productKey, itemRef }),
  ).toBeNull();
  expect(
    service.verify({
      appId: claims.appId,
      productKey: claims.productKey,
      itemRef: service.issue(claims),
    }),
  ).toEqual({ ...claims, source: 'item_ref' });
});

it('[AC-B1-05h] non-crypto failures of the cipher are not swallowed', () => {
  const service = createItemRefService({ crypto });
  expect(() =>
    service.verify({ appId: claims.appId, productKey: claims.productKey, itemRef: 'other|x' }),
  ).toThrowError('unexpected cipher input');
});
