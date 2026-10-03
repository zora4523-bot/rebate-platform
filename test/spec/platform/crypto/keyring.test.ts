// Rule tests for 规划/08 BR-ID-33, the key-handling clauses: KMS 信封加密、密文带 key_version、
// 支持轮换。Envelope encryption here means: data keys exist in stored form only wrapped by the
// master key of a KeyProvider (KMS in the cloud; the tests use an in-test stand-in, FakeKms),
// and the cipher gets every key through that provider. Rotation adds a data key version and
// keeps every older one, so that existing ciphertexts stay readable.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  type WrappedKeyring,
  createWrappedKeyring,
  openFieldCrypto,
  rotateDataKey,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FakeKms,
  KEY_BYTES,
  SAMPLES,
  encodingsOf,
  fakeUnwrap,
  fakeWrap,
  knownKeyring,
  outcomeOf,
  referenceDecrypt,
  rejectionOf,
  testBytes,
  testKey,
} from './kit.ts';

const CONTEXT = 'realname.id_no';

function sortedVersions(doc: WrappedKeyring): number[] {
  return doc.data_keys.map((entry) => entry.version).sort((a, b) => a - b);
}

function wrappedOf(doc: WrappedKeyring, version: number): string | undefined {
  return doc.data_keys.find((entry) => entry.version === version)?.wrapped;
}

it('[BR-ID-33] 信封加密：createWrappedKeyring 生成的数据密钥与盲索引密钥都经 provider.wrapKey 包裹，文档里找不到任何明文密钥的编码', async () => {
  const kms = new FakeKms();
  const doc = await createWrappedKeyring(kms);
  const [first, second] = kms.wrappedPlainKeys;
  const dataKey = fakeUnwrap(wrappedOf(doc, 1) ?? '', kms.keyId);
  const blindKey = fakeUnwrap(doc.blind_index_key, kms.keyId);
  const text = JSON.stringify(doc).toLowerCase();
  const plainEncodingsInDoc = kms.wrappedPlainKeys.flatMap((key) =>
    encodingsOf(key).filter((encoding) => text.includes(encoding.toLowerCase())),
  );
  expect({
    keyId: doc.key_id,
    current: doc.current_version,
    versions: sortedVersions(doc),
    wrapCalls: kms.wrappedPlainKeys.length,
    // Both stored keys are exactly what the provider was asked to wrap.
    storedAreTheWrappedOnes:
      [first, second].some((key) => key?.equals(dataKey)) &&
      [first, second].some((key) => key?.equals(blindKey)),
    dataKeyBytes: dataKey.length,
    blindKeyBytes: blindKey.length,
    dataKeyDiffersFromBlindKey: !dataKey.equals(blindKey),
    plainEncodingsInDoc,
  }).toEqual({
    keyId: kms.keyId,
    current: 1,
    versions: [1],
    wrapCalls: 2,
    storedAreTheWrappedOnes: true,
    dataKeyBytes: KEY_BYTES,
    blindKeyBytes: KEY_BYTES,
    dataKeyDiffersFromBlindKey: true,
    plainEncodingsInDoc: [],
  });
});

it('[BR-ID-33] 每次新建或轮换生成的密钥都是新的随机 32 字节：两份新 keyring 加两次轮换，6 把密钥两两不同', async () => {
  const kms = new FakeKms();
  const a = await createWrappedKeyring(kms);
  await createWrappedKeyring(kms);
  await rotateDataKey(await rotateDataKey(a, kms), kms);
  expect({
    keys: kms.wrappedPlainKeys.length,
    lengths: [...new Set(kms.wrappedPlainKeys.map((key) => key.length))],
    distinct: new Set(kms.wrappedPlainKeys.map((key) => key.toString('hex'))).size,
  }).toEqual({ keys: 6, lengths: [KEY_BYTES], distinct: 6 });
});

it('[BR-ID-33] 信封加密：openFieldCrypto 把文档里每一个包裹密钥都交给 provider.unwrapKey 解包，拿到的就是这些密钥', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1, 2, 3], 3);
  const crypto = await openFieldCrypto(known.doc, kms);
  const ciphertext = crypto.encrypt(SAMPLES.idNo, CONTEXT);
  expect({
    unwrapRequests: [...new Set(kms.unwrapRequests)].sort(),
    wrapCalls: kms.wrappedPlainKeys.length,
    // The key the provider returned for version 3 is the one that encrypts.
    decryptedWithUnwrappedKey: referenceDecrypt(known.dataKey(3), ciphertext, CONTEXT),
  }).toEqual({
    unwrapRequests: [
      ...known.doc.data_keys.map((entry) => entry.wrapped),
      known.doc.blind_index_key,
    ].sort(),
    wrapCalls: 0,
    decryptedWithUnwrappedKey: SAMPLES.idNo,
  });
});

it('[BR-ID-33] provider 解包任何一把密钥失败，openFieldCrypto 整体拒绝，不返回只带部分密钥的对象', async () => {
  const outcomes: Record<string, string> = {};
  for (const failing of ['oldDataKey', 'currentDataKey', 'blindIndexKey'] as const) {
    const kms = new FakeKms();
    const known = knownKeyring(kms, [1, 2], 2);
    kms.failUnwrapOf =
      failing === 'blindIndexKey'
        ? known.doc.blind_index_key
        : (wrappedOf(known.doc, failing === 'oldDataKey' ? 1 : 2) ?? null);
    outcomes[failing] = await rejectionOf(() => openFieldCrypto(known.doc, kms));
  }
  // The provider's own error comes through; what matters is that nothing is returned.
  expect(outcomes).toEqual({
    oldDataKey: 'other error: Error: fake kms: unwrap refused',
    currentDataKey: 'other error: Error: fake kms: unwrap refused',
    blindIndexKey: 'other error: Error: fake kms: unwrap refused',
  });
});

it('[BR-ID-33] keyring 是别的主密钥包裹的（key_id 与 provider.keyId 不同）：openFieldCrypto 与 rotateDataKey 都以 invalid_keyring 拒绝，不拿去试解', async () => {
  const kms = new FakeKms('fake-kms/master-a');
  const other = new FakeKms('fake-kms/master-b');
  const known = knownKeyring(kms, [1], 1);
  expect({
    open: await rejectionOf(() => openFieldCrypto(known.doc, other)),
    rotate: await rejectionOf(() => rotateDataKey(known.doc, other)),
    unwrapRequests: other.unwrapRequests.length,
    wrapCalls: other.wrappedPlainKeys.length,
  }).toEqual({
    open: 'invalid_keyring',
    rotate: 'invalid_keyring',
    unwrapRequests: 0,
    wrapCalls: 0,
  });
});

it('[BR-ID-33] 形状不对的 keyring 一律 invalid_keyring：没有数据密钥、当前版本不在其中、版本重复、版本不是 1 到 2147483647 的整数、缺字段', async () => {
  const kms = new FakeKms();
  const good = knownKeyring(kms, [1, 2], 2).doc;
  const entry = (version: unknown): { version: number; wrapped: string } => ({
    version: version as number,
    wrapped: fakeWrap(testKey(1), kms.keyId),
  });
  const bad: Record<string, unknown> = {
    noDataKeys: { ...good, data_keys: [] },
    currentMissing: { ...good, current_version: 3 },
    duplicateVersion: { ...good, data_keys: [entry(1), entry(2), entry(2)] },
    versionZero: { ...good, current_version: 0, data_keys: [entry(0)] },
    versionNegative: { ...good, current_version: -1, data_keys: [entry(-1)] },
    versionFraction: { ...good, current_version: 1.5, data_keys: [entry(1.5)] },
    versionTooLarge: { ...good, current_version: 2147483648, data_keys: [entry(2147483648)] },
    versionAsString: { ...good, current_version: 2, data_keys: [entry(1), entry('2')] },
    wrappedNotAString: { ...good, data_keys: [entry(1), { version: 2, wrapped: 42 }] },
    blindIndexKeyMissing: { key_id: good.key_id, current_version: 2, data_keys: good.data_keys },
    keyIdMissing: {
      current_version: 2,
      data_keys: good.data_keys,
      blind_index_key: good.blind_index_key,
    },
    dataKeysNotAList: { ...good, data_keys: { 1: 'x' } },
    notAnObject: 'keyring',
    nullDocument: null,
  };
  const expected = Object.fromEntries(Object.keys(bad).map((name) => [name, 'invalid_keyring']));
  const open: Record<string, string> = {};
  const rotate: Record<string, string> = {};
  for (const [name, doc] of Object.entries(bad)) {
    open[name] = await rejectionOf(() => openFieldCrypto(doc as WrappedKeyring, kms));
    rotate[name] = await rejectionOf(() => rotateDataKey(doc as WrappedKeyring, kms));
  }
  expect({
    goodOpens: await rejectionOf(() => openFieldCrypto(good, kms)),
    open,
    rotate,
  }).toEqual({ goodOpens: 'resolved', open: expected, rotate: expected });
});

it('[BR-ID-33] AES-256 只接受 32 字节数据密钥：解包出 16、31、33 字节一律 invalid_key；盲索引密钥短于 32 字节同样拒绝', async () => {
  const kms = new FakeKms();
  const good = knownKeyring(kms, [1], 1).doc;
  const withDataKey = (length: number): WrappedKeyring => ({
    ...good,
    data_keys: [{ version: 1, wrapped: fakeWrap(testBytes(7, length), kms.keyId) }],
  });
  const withBlindKey = (length: number): WrappedKeyring => ({
    ...good,
    blind_index_key: fakeWrap(testBytes(8, length), kms.keyId),
  });
  expect({
    dataKey16: await rejectionOf(() => openFieldCrypto(withDataKey(16), kms)),
    dataKey31: await rejectionOf(() => openFieldCrypto(withDataKey(31), kms)),
    dataKey33: await rejectionOf(() => openFieldCrypto(withDataKey(33), kms)),
    dataKey32: await rejectionOf(() => openFieldCrypto(withDataKey(32), kms)),
    blindKey16: await rejectionOf(() => openFieldCrypto(withBlindKey(16), kms)),
    blindKey31: await rejectionOf(() => openFieldCrypto(withBlindKey(31), kms)),
    blindKey32: await rejectionOf(() => openFieldCrypto(withBlindKey(32), kms)),
    blindKey64: await rejectionOf(() => openFieldCrypto(withBlindKey(64), kms)),
  }).toEqual({
    dataKey16: 'invalid_key',
    dataKey31: 'invalid_key',
    dataKey33: 'invalid_key',
    dataKey32: 'resolved',
    blindKey16: 'invalid_key',
    blindKey31: 'invalid_key',
    blindKey32: 'resolved',
    blindKey64: 'resolved',
  });
});

it('[BR-ID-33] 轮换：rotateDataKey 新增的版本是现有最大版本 + 1 并成为当前版本，旧条目与盲索引密钥原样保留，传入的文档不被改动', async () => {
  const kms = new FakeKms();
  // The current version (2) is not the highest (5): the new one is 6, not 3.
  const before = knownKeyring(kms, [1, 2, 5], 2).doc;
  const snapshot = structuredClone(before);
  const after = await rotateDataKey(before, kms);
  const [newKey] = kms.wrappedPlainKeys;
  expect({
    inputUntouched: before,
    isNewObject: after !== before,
    keyId: after.key_id,
    current: after.current_version,
    versions: sortedVersions(after),
    oldEntries: [1, 2, 5].map((version) => wrappedOf(after, version)),
    blindIndexKey: after.blind_index_key,
    wrapCalls: kms.wrappedPlainKeys.length,
    newKeyBytes: newKey?.length,
    newEntryIsTheWrappedNewKey:
      newKey !== undefined && wrappedOf(after, 6) === fakeWrap(newKey, kms.keyId),
  }).toEqual({
    inputUntouched: snapshot,
    isNewObject: true,
    keyId: before.key_id,
    current: 6,
    versions: [1, 2, 5, 6],
    oldEntries: [1, 2, 5].map((version) => wrappedOf(before, version)),
    blindIndexKey: before.blind_index_key,
    wrapCalls: 1,
    newKeyBytes: KEY_BYTES,
    newEntryIsTheWrappedNewKey: true,
  });
});

it('[BR-ID-33] 轮换后旧密文照常解密，新密文带新版本；needsReencrypt 只对旧版本为真；reencrypt 换成当前版本，原文不变', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1, 2], 2);
  const before = await openFieldCrypto(known.doc, kms);
  const oldCiphertext = before.encrypt(SAMPLES.idNo, CONTEXT);
  const veryOldCiphertext = before.reencrypt(oldCiphertext, CONTEXT);

  const rotated = await rotateDataKey(known.doc, kms);
  const after = await openFieldCrypto(rotated, kms);
  const newKey = kms.wrappedPlainKeys[0] ?? Buffer.alloc(0);
  const fresh = after.encrypt(SAMPLES.idNo, CONTEXT);
  const reencrypted = after.reencrypt(oldCiphertext, CONTEXT);
  expect({
    oldVersion: after.keyVersionOf(oldCiphertext),
    oldStillDecrypts: after.decrypt(oldCiphertext, CONTEXT),
    reencryptUnderSameVersionStillDecrypts: after.decrypt(veryOldCiphertext, CONTEXT),
    current: after.currentKeyVersion,
    freshVersion: after.keyVersionOf(fresh),
    freshDecryptsWithTheNewKey: referenceDecrypt(newKey, fresh, CONTEXT),
    needsReencryptOld: after.needsReencrypt(oldCiphertext),
    needsReencryptFresh: after.needsReencrypt(fresh),
    reencryptedVersion: after.keyVersionOf(reencrypted),
    reencryptedText: referenceDecrypt(newKey, reencrypted, CONTEXT),
    reencryptedIsANewCiphertext: reencrypted !== oldCiphertext,
    reencryptWrongContext: outcomeOf(() => after.reencrypt(oldCiphertext, 'users.phone')),
    // The cipher opened before the rotation does not hold version 3.
    oldCipherOnFresh: outcomeOf(() => before.decrypt(fresh, CONTEXT)),
    oldCipherNeedsReencryptFresh: before.needsReencrypt(fresh),
  }).toEqual({
    oldVersion: 2,
    oldStillDecrypts: SAMPLES.idNo,
    reencryptUnderSameVersionStillDecrypts: SAMPLES.idNo,
    current: 3,
    freshVersion: 3,
    freshDecryptsWithTheNewKey: SAMPLES.idNo,
    needsReencryptOld: true,
    needsReencryptFresh: false,
    reencryptedVersion: 3,
    reencryptedText: SAMPLES.idNo,
    reencryptedIsANewCiphertext: true,
    reencryptWrongContext: 'decrypt_failed',
    oldCipherOnFresh: 'unknown_key_version',
    oldCipherNeedsReencryptFresh: true,
  });
});

it('[BR-ID-33] 连续轮换 3 次后，4 个版本的密文都还能解开，各自由自己那一版的密钥加密', async () => {
  const kms = new FakeKms();
  let doc = await createWrappedKeyring(kms);
  const ciphertexts: string[] = [];
  for (let round = 0; round < 4; round += 1) {
    if (round > 0) doc = await rotateDataKey(doc, kms);
    const crypto = await openFieldCrypto(doc, kms);
    ciphertexts.push(crypto.encrypt(`${SAMPLES.idNo}#${String(round)}`, CONTEXT));
  }
  const last = await openFieldCrypto(doc, kms);
  // createWrappedKeyring wrapped the data key of version 1 and the blind-index key; every later
  // wrap call is the data key of the next version.
  const dataKeyOf = (version: number): Buffer =>
    fakeUnwrap(wrappedOf(doc, version) ?? '', kms.keyId);
  expect({
    versions: ciphertexts.map((c) => last.keyVersionOf(c)),
    decrypted: ciphertexts.map((c) => last.decrypt(c, CONTEXT)),
    eachUnderItsOwnKey: ciphertexts.map((c, i) => referenceDecrypt(dataKeyOf(i + 1), c, CONTEXT)),
    needsReencrypt: ciphertexts.map((c) => last.needsReencrypt(c)),
  }).toEqual({
    versions: [1, 2, 3, 4],
    decrypted: [0, 1, 2, 3].map((round) => `${SAMPLES.idNo}#${String(round)}`),
    eachUnderItsOwnKey: [0, 1, 2, 3].map((round) => `${SAMPLES.idNo}#${String(round)}`),
    needsReencrypt: [true, true, true, false],
  });
});
