import { expect, it } from 'vitest';
import {
  createItemRefService,
  processItemRefCipher,
  type ItemRefClaims,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/index.ts';

const claims: ItemRefClaims = {
  appId: 'synthetic_key_app',
  platform: 'taobao',
  productKey: 'tb:synthetic001',
  rawItemId: 'synthetic-prefix-synthetic001',
  fetchedAt: '2026-10-08T04:00:00.000Z',
};

it('[AC-B1-05k#1] catalog 公开提供者反复调用返回同一个进程内实例', () => {
  const first = processItemRefCipher();
  expect(processItemRefCipher()).toBe(first);
  expect(processItemRefCipher()).toBe(first);
});

it('[AC-B1-05k#2] 分别取得的临时密钥可双向验证，后续调用不会换掉已签发令牌的密钥', () => {
  const first = createItemRefService({ crypto: processItemRefCipher() });
  const issued = first.issue(claims);
  const second = createItemRefService({ crypto: processItemRefCipher() });
  expect(second.verify({ ...claims, itemRef: issued })).toEqual({
    ...claims,
    source: 'item_ref',
  });
  const next = { ...claims, rawItemId: 'synthetic-new-prefix-synthetic001' };
  const reverse = second.issue(next);
  expect(first.verify({ ...claims, itemRef: reverse })).toEqual({
    ...next,
    source: 'item_ref',
  });
  const later = createItemRefService({ crypto: processItemRefCipher() });
  expect(later.verify({ ...claims, itemRef: issued })?.rawItemId).toBe(claims.rawItemId);
});

it('[AC-B1-05k#3] 共用临时密钥仍验证 app_id、product_key 和密文完整性', () => {
  const issuer = createItemRefService({ crypto: processItemRefCipher() });
  const verifier = createItemRefService({ crypto: processItemRefCipher() });
  const issued = issuer.issue(claims);
  expect(verifier.verify({ ...claims, appId: 'synthetic_other', itemRef: issued })).toBeNull();
  expect(() =>
    verifier.verify({ ...claims, productKey: 'tb:synthetic_other', itemRef: issued }),
  ).toThrow(expect.objectContaining({ code: 20001 }));
  const offset = Math.floor(issued.length / 2);
  const altered =
    issued.slice(0, offset) + (issued[offset] === 'A' ? 'B' : 'A') + issued.slice(offset + 1);
  expect(verifier.verify({ ...claims, itemRef: altered })).toBeNull();
});

it.each([
  ['local', 'staging'],
  ['test', 'prod'],
] as const)(
  '[AC-B1-05k#4] %s 可用进程临时密钥，%s 未配字段密钥环仍拒绝启动',
  (localEnv, appEnv) => {
    let result: unknown;
    try {
      result = loadConfig({ APP_ENV: appEnv });
    } catch (error: unknown) {
      result = error;
    }
    expect(result).toMatchObject({
      name: 'ConfigError',
      problems: expect.arrayContaining([`FIELD_KEY_PROVIDER: must be set when APP_ENV=${appEnv}`]),
    });
    expect(loadConfig({ APP_ENV: localEnv }).keyring).toBeNull();
    const first = processItemRefCipher();
    const encrypted = first.encrypt('synthetic-value', 'catalog.item_ref');
    expect(processItemRefCipher().decrypt(encrypted, 'catalog.item_ref')).toBe('synthetic-value');
  },
);
