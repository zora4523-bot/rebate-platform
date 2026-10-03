import { createCipheriv, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
  rotateDataKey,
  type KeyProvider,
} from './index.ts';

it('[AC-B1-01a#1] 主密钥与解包密钥不保留调用方的可变字节引用', async () => {
  const master = randomBytes(32);
  const originalMaster = Buffer.from(master);
  const local = new LocalKeyProvider(master);
  master.fill(0);
  const doc = await createWrappedKeyring(local);
  const reopened = await openFieldCrypto(doc, new LocalKeyProvider(originalMaster));
  const buffers: Uint8Array[] = [];
  const provider: KeyProvider = {
    keyId: local.keyId,
    wrapKey: (key) => local.wrapKey(key),
    async unwrapKey(wrapped) {
      const key = await local.unwrapKey(wrapped);
      buffers.push(key);
      return key;
    },
  };
  const crypto = await openFieldCrypto(doc, provider);
  const value = 'synthetic-value';
  const cipher = crypto.encrypt(value, 'unit.field');
  const index = crypto.blindIndex(value, 'unit.field');
  for (const buffer of buffers) buffer.fill(0);
  expect({
    decrypted: crypto.decrypt(cipher, 'unit.field'),
    reopened: reopened.decrypt(cipher, 'unit.field'),
    index: crypto.blindIndex(value, 'unit.field'),
    referenceIndex: reopened.blindIndex(value, 'unit.field'),
  }).toEqual({ decrypted: value, reopened: value, index, referenceIndex: index });
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
