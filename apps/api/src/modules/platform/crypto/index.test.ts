import { createCipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import {
  FIELD_CRYPTO_MESSAGES,
  FieldCryptoError,
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
  rotateDataKey,
  type KeyProvider,
} from './index.ts';

it('[AC-B1-01a#1] 主密钥与解包密钥不保留调用方的可变字节引用', async () => {
  const master = randomBytes(32);
  const originalMaster = new Uint8Array(master);
  const local = new LocalKeyProvider(master);
  master.fill(0);
  const doc = await createWrappedKeyring(local);
  const reopened = await openFieldCrypto(doc, new LocalKeyProvider(originalMaster));
  const buffers: Uint8Array[] = [];
  const references: Uint8Array[] = [];
  const provider: KeyProvider = {
    keyId: local.keyId,
    wrapKey: (key) => local.wrapKey(key),
    async unwrapKey(wrapped) {
      const key = await local.unwrapKey(wrapped);
      buffers.push(key);
      references.push(new Uint8Array(key));
      return key;
    },
  };
  const crypto = await openFieldCrypto(doc, provider);
  const value = 'synthetic-value';
  const cipher = crypto.encrypt(value, 'unit.field');
  const index = crypto.blindIndex(value, 'unit.field');
  expect(buffers.map((buffer) => new Uint8Array(buffer))).toEqual(references);
  for (const buffer of buffers) buffer.fill(0);
  expect({
    decrypted: crypto.decrypt(cipher, 'unit.field'),
    reopened: reopened.decrypt(cipher, 'unit.field'),
    index: crypto.blindIndex(value, 'unit.field'),
    referenceIndex: reopened.blindIndex(value, 'unit.field'),
  }).toEqual({ decrypted: value, reopened: value, index, referenceIndex: index });
});

it('[AC-B1-01a#5] 打开多版本密钥环及加解密、盲索引后共享池中没有任何密钥', async () => {
  const master = randomBytes(32);
  const references: Uint8Array[] = [new Uint8Array(master)];
  // Retain every pool seen around the operations, including a pool replaced along the way.
  const pools = new Set<ArrayBufferLike>();
  function probePool(): void {
    pools.add(Buffer.from('x').buffer);
  }
  probePool();
  const provider = new LocalKeyProvider(master);
  probePool();
  let doc = await createWrappedKeyring(provider);
  probePool();
  doc = await rotateDataKey(doc, provider);
  probePool();
  for (const wrapped of [...doc.data_keys.map((entry) => entry.wrapped), doc.blind_index_key]) {
    const key = await provider.unwrapKey(wrapped);
    references.push(new Uint8Array(key));
    key.fill(0);
    probePool();
  }
  const crypto = await openFieldCrypto(doc, provider);
  probePool();
  function poolHasKey(): boolean {
    return [...pools].some((pool) =>
      references.some((key) =>
        Buffer.from(pool).includes(Buffer.from(key.buffer, key.byteOffset, key.byteLength)),
      ),
    );
  }
  expect(poolHasKey()).toBe(false);
  const ciphertext = crypto.encrypt('synthetic-secret-value', 'unit.field');
  probePool();
  expect(poolHasKey()).toBe(false);
  expect(crypto.decrypt(ciphertext, 'unit.field')).toBe('synthetic-secret-value');
  probePool();
  expect(poolHasKey()).toBe(false);
  expect(crypto.blindIndex('synthetic-secret-value', 'unit.field')).toMatch(/^[a-f0-9]{64}$/u);
  probePool();
  expect(poolHasKey()).toBe(false);
});

it('[AC-B1-01a#6] 解包返回的底层内存只容纳该密钥，不含主密钥且不改调用方字节', async () => {
  const master = randomBytes(32);
  const masterReference = new Uint8Array(master);
  const provider = new LocalKeyProvider(master);
  for (const size of [1, 32, 64, 8193]) {
    const key = randomBytes(size);
    const reference = new Uint8Array(key);
    const unwrapped = await provider.unwrapKey(await provider.wrapKey(key));
    expect(unwrapped.buffer.byteLength).toBe(size);
    expect(unwrapped.byteOffset).toBe(0);
    expect(new Uint8Array(unwrapped)).toEqual(reference);
    expect(Buffer.from(unwrapped.buffer).includes(Buffer.from(masterReference.buffer))).toBe(false);
    expect(new Uint8Array(key)).toEqual(reference);
    unwrapped.fill(0);
    expect(new Uint8Array(key)).toEqual(reference);
  }
  expect(new Uint8Array(master)).toEqual(masterReference);
});

it('[AC-B1-01a#7] 三个入口丢弃 keyId getter 的原始错误及其中的手机号', async () => {
  const local = new LocalKeyProvider(randomBytes(32));
  const doc = await createWrappedKeyring(local);
  const phone = '13877776666';
  const provider: KeyProvider = {
    get keyId(): string {
      throw new Error(`kms config for ${phone}`);
    },
    wrapKey: (key) => local.wrapKey(key),
    unwrapKey: (wrapped) => local.unwrapKey(wrapped),
  };
  for (const attempt of [
    () => createWrappedKeyring(provider),
    () => openFieldCrypto(doc, provider),
    () => rotateDataKey(doc, provider),
  ]) {
    const error: unknown = await attempt().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(FieldCryptoError);
    expect(error).toMatchObject({
      code: 'key_provider_failed',
      message: FIELD_CRYPTO_MESSAGES.key_provider_failed,
    });
    expect(inspect(error, { showHidden: true })).not.toContain(phone);
    expect(Object.getOwnPropertyDescriptors(error)).not.toHaveProperty('cause');
    expect(inspect(Object.getOwnPropertyDescriptors(error), { depth: null })).not.toContain(phone);
  }
});

it('[AC-B1-01a#8] 三个入口拒绝空 provider 及非法 keyId，统一返回 FieldCryptoError', async () => {
  const local = new LocalKeyProvider(randomBytes(32));
  const doc = await createWrappedKeyring(local);
  for (const invalid of [
    null,
    undefined,
    { keyId: null },
    { keyId: 1 },
    { keyId: '' },
    { keyId: '\ud800' },
  ]) {
    const provider = invalid as unknown as KeyProvider;
    for (const attempt of [
      () => createWrappedKeyring(provider),
      () => openFieldCrypto(doc, provider),
      () => rotateDataKey(doc, provider),
    ]) {
      const error: unknown = await attempt().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(FieldCryptoError);
      expect(error).toMatchObject({
        code: 'invalid_keyring',
        message: FIELD_CRYPTO_MESSAGES.invalid_keyring,
      });
    }
  }
});

it('[AC-B1-01a#2] 异步解包期间修改原文档不会替换已校验的版本与条目', async () => {
  const local = new LocalKeyProvider(randomBytes(32));
  const created = await createWrappedKeyring(local);
  const doc = { ...created, data_keys: created.data_keys.map((entry) => ({ ...entry })) };
  const provider: KeyProvider = {
    keyId: local.keyId,
    wrapKey: (key) => local.wrapKey(key),
    async unwrapKey(wrapped) {
      doc.current_version = 99;
      doc.data_keys.length = 0;
      doc.blind_index_key = 'replaced';
      return local.unwrapKey(wrapped);
    },
  };
  const crypto = await openFieldCrypto(doc, provider);
  const reference = await openFieldCrypto(created, local);
  expect({
    current: crypto.currentKeyVersion,
    decrypted: reference.decrypt(crypto.encrypt('sample', 'unit.field'), 'unit.field'),
    index: crypto.blindIndex('sample', 'unit.field'),
  }).toEqual({
    current: 1,
    decrypted: 'sample',
    index: reference.blindIndex('sample', 'unit.field'),
  });
});

it('[AC-B1-01a#3] 版本号耗尽时拒绝轮换，且不调用密钥提供者', async () => {
  const local = new LocalKeyProvider(randomBytes(32));
  const doc = await createWrappedKeyring(local);
  const wrapped = doc.data_keys[0]?.wrapped ?? '';
  let calls = 0;
  const provider: KeyProvider = {
    keyId: local.keyId,
    wrapKey(key) {
      calls += 1;
      return local.wrapKey(key);
    },
    unwrapKey: (key) => local.unwrapKey(key),
  };
  await expect(
    rotateDataKey(
      { ...doc, current_version: 2_147_483_647, data_keys: [{ version: 2_147_483_647, wrapped }] },
      provider,
    ),
  ).rejects.toMatchObject({ code: 'invalid_keyring' });
  expect(calls).toBe(0);
});

it('[AC-B1-01a#4] 保留 Unicode BOM，拒绝认证通过但不是 UTF-8 的载荷和非规范编码', async () => {
  const provider = new LocalKeyProvider(randomBytes(32));
  const doc = await createWrappedKeyring(provider);
  const crypto = await openFieldCrypto(doc, provider);
  const value = '\ufeffsynthetic-value';
  expect(crypto.decrypt(crypto.encrypt(value, 'unit.field'), 'unit.field')).toBe(value);
  const dataKey = await provider.unwrapKey(doc.data_keys[0]?.wrapped ?? '');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(Buffer.from('unit.field'));
  const payload = Buffer.concat([
    iv,
    cipher.update(Buffer.from([0xff])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  expect(() => crypto.decrypt(`v1.1.${payload.toString('base64url')}`, 'unit.field')).toThrow(
    expect.objectContaining({ code: 'decrypt_failed' }),
  );
  // A 30-byte payload has no unused bits; a dangling extra base64 character decodes to the
  // same bytes in Node, but must not be accepted as another spelling of the ciphertext.
  const noncanonical = `${Buffer.alloc(30).toString('base64url')}A`;
  expect(() => crypto.keyVersionOf(`v1.1.${noncanonical}`)).toThrow(
    expect.objectContaining({ code: 'malformed_ciphertext' }),
  );
});
