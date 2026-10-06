import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import {
  openFieldCrypto,
  rotateDataKey,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { CONTEXT, claims, corrupt, fixture, payload } from './kit.ts';

// BR-PROD-11. All IDs are synthetic; no platform recording or production key is used.
it('[AC-B1-05h#1] 签发内容恰为五个商品字段，不夹带用户或归因上下文', async () => {
  const { crypto, service } = await fixture();
  const input = {
    ...claims(),
    userId: 'viewer-a',
    user_id: 'viewer-b',
    relation_id: 'relation-demo',
    pid: 'placement-demo',
  };
  const issued = service.issue(input);
  expect(issued).toBeTypeOf('string');
  expect(issued.length).toBeGreaterThan(0);
  const plaintext = crypto.decrypt(issued, CONTEXT);
  expect(JSON.parse(plaintext)).toEqual(payload(claims()));
  for (const value of Object.values(payload(claims()))) {
    expect(issued).not.toContain(value);
  }
  expect(Buffer.from(issued, 'base64url').toString('utf8')).not.toContain(input.rawItemId);
  expect(service.verify({ ...input, itemRef: issued })).toEqual({
    ...claims(),
    source: 'item_ref',
  });
});

it.each([
  { platform: 'taobao' as const, productKey: 'tb:AbC001', rawItemId: 'prefix-000123-AbC001' },
  { platform: 'jd' as const, productKey: 'jd:i_00042', rawItemId: 'prefix_00042_tail' },
  { platform: 'jd' as const, productKey: 'jd:9007199254740993', rawItemId: '9007199254740993' },
  { platform: 'pdd' as const, productKey: 'pdd:00042', rawItemId: '演示签名+/=%_AbC-00042' },
])('[AC-B1-05h#2] $platform 的原串逐字保留并可由另一服务实例验证', async (identity) => {
  const { provider, keyring, service, create } = await fixture();
  const input = claims(identity);
  const issued = service.issue(input);
  const independent = create({ crypto: await openFieldCrypto(keyring, provider) });
  expect(independent.verify({ ...input, itemRef: issued })).toEqual({
    ...input,
    source: 'item_ref',
  });
});

it('[AC-B1-05h#3] 同卡片重复签发仍使用随机加密，令牌可被不同用户反复透传', async () => {
  const { service } = await fixture();
  const input = claims();
  const first = service.issue(input);
  const second = service.issue(input);
  expect(first).not.toBe(second);
  for (const userId of ['viewer-a', 'viewer-b', null, 'viewer-a']) {
    const request = { appId: input.appId, productKey: input.productKey, userId, itemRef: first };
    expect(service.verify(request)).toEqual({ ...input, source: 'item_ref' });
  }
  expect(service.verify({ ...input, itemRef: second })).toEqual({ ...input, source: 'item_ref' });
});

it.each([undefined, null, '', 'not-an-item-ref', 'v1.1.!', 'v1.1.AA'])(
  '[AC-B1-05h#4] 缺失或无法解码的令牌 %s 返回 null，不报错',
  async (itemRef) => {
    const { service } = await fixture();
    const scope = { appId: claims().appId, productKey: claims().productKey };
    expect(service.verify(itemRef === undefined ? scope : { ...scope, itemRef })).toBeNull();
  },
);

it.each(['iv', 'body', 'tag'] as const)(
  '[AC-B1-05h#5] 篡改 %s 后忽略令牌，即使请求商品不同也不报 20001',
  async (part) => {
    const { service } = await fixture();
    const itemRef = corrupt(service.issue(claims()), part);
    expect(service.verify({ ...claims(), itemRef })).toBeNull();
    expect(service.verify({ ...claims(), productKey: 'tb:Other', itemRef })).toBeNull();
  },
);

it('[AC-B1-05h#6] 未知密钥版本和不同密钥无法解密时都忽略', async () => {
  const { service } = await fixture();
  const other = await fixture();
  const issued = service.issue(claims());
  const unknownVersion = issued.replace(/^v1\.\d+\./u, 'v1.2147483647.');
  expect(service.verify({ ...claims(), itemRef: unknownVersion })).toBeNull();
  expect(other.service.verify({ ...claims(), itemRef: issued })).toBeNull();
});

it('[AC-B1-05h#7] app_id 不符优先静默忽略，不泄漏令牌内商品是否匹配', async () => {
  const { service } = await fixture();
  const itemRef = service.issue(claims());
  for (const productKey of [claims().productKey, 'tb:Other']) {
    expect(service.verify({ appId: 'app-item-ref-b', productKey, itemRef })).toBeNull();
  }
});

it.each(['tb:Other', 'tb:abc001', 'jd:AbC001'])(
  '[AC-B1-05h#8] 认证通过且同应用但商品为 %s 时返回错误码 20001',
  async (productKey) => {
    const { service } = await fixture();
    const itemRef = service.issue(claims());
    expect(() => service.verify({ ...claims(), productKey, itemRef })).toThrowError(
      expect.objectContaining({ code: 20001 }),
    );
  },
);

it('[AC-B1-05h#9] 有效认证却无法解码为完整商品引用的内容静默忽略', async () => {
  const { crypto, service } = await fixture();
  const valid = payload(claims());
  const incomplete = Object.keys(valid).map((field) =>
    JSON.stringify(Object.fromEntries(Object.entries(valid).filter(([name]) => name !== field))),
  );
  for (const plaintext of [
    'not-json',
    'null',
    '[]',
    '{}',
    ...incomplete,
    JSON.stringify({ ...valid, raw_item_id: 42 }),
    JSON.stringify({ ...valid, fetched_at: 'not-an-instant' }),
  ]) {
    const itemRef = crypto.encrypt(plaintext, CONTEXT);
    expect(service.verify({ ...claims(), itemRef })).toBeNull();
  }
});

it('[AC-B1-05h#10] 其他加密字段的密文不能充当 item_ref', async () => {
  const { crypto, service } = await fixture();
  const itemRef = crypto.encrypt(JSON.stringify(payload(claims())), 'users.phone');
  expect(service.verify({ ...claims(), itemRef })).toBeNull();
});

it('[AC-B1-05h#11] 密钥轮换后仍能验证旧卡片，新签发使用现有 keyring', async () => {
  const { service, create, provider, keyring } = await fixture();
  const previous = service.issue(claims());
  const rotated = await rotateDataKey(keyring, provider);
  const crypto = await openFieldCrypto(rotated, provider);
  const next = create({ crypto });
  expect(next.verify({ ...claims(), itemRef: previous })).toEqual({
    ...claims(),
    source: 'item_ref',
  });
  const issued = next.issue(claims());
  expect(crypto.keyVersionOf(issued)).toBe(rotated.current_version);
  expect(next.verify({ ...claims(), itemRef: issued })).toEqual({
    ...claims(),
    source: 'item_ref',
  });
});

it('[AC-B1-05h#12] 成功、忽略和业务错误路径不把令牌或解密原串写进输出或错误', async () => {
  const { service } = await fixture();
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const itemRef = service.issue(claims());
    expect(service.verify({ ...claims(), itemRef })).toEqual({ ...claims(), source: 'item_ref' });
    expect(service.verify({ ...claims(), itemRef: corrupt(itemRef, 'tag') })).toBeNull();
    let failure: unknown;
    try {
      service.verify({ ...claims(), productKey: 'tb:Other', itemRef });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 20001 });
    const visible = inspect([stdout.mock.calls, stderr.mock.calls, failure], { depth: null });
    expect(visible).not.toContain(itemRef);
    expect(visible).not.toContain(claims().rawItemId);
    expect(visible).not.toContain(JSON.stringify(payload(claims())));
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
