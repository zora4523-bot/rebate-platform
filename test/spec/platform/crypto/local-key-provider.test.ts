// Rule tests for 规划/08 BR-ID-33 (KMS 信封加密) on the local side: ADR-0001 §2 鉴权与密钥 says
// the KeyProvider is a file / in-memory key locally and KMS in the cloud. LocalKeyProvider is
// the local one: it must behave like a master key holder (wrap, unwrap, refuse foreign or
// altered text), so that local and test runs go through the same envelope path as production.
// Its wrapped-key format (`lk1.<base64url(IV ‖ ciphertext ‖ tag)>`, AES-256-GCM under the master
// key, AAD = keyId) is part of the contract, so the tests read the IV and decrypt with node:crypto.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  LocalKeyProvider,
  type WrappedKeyring,
  createWrappedKeyring,
  openFieldCrypto,
  rotateDataKey,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  IV_BYTES,
  SAMPLES,
  TAG_BYTES,
  b64url,
  ivOfLk1,
  outcomeOf,
  parseLk1,
  referenceBlindIndex,
  referenceUnwrap,
  referenceWrap,
  rejectionOf,
  testBytes,
  testKey,
} from './kit.ts';

const MASTER_A = 240;
const MASTER_B = 241;

it('[BR-ID-33] LocalKeyProvider 按 lk1 格式包裹：wrapKey 写出 lk1.<base64url(IV ‖ 密文 ‖ tag)>，密文与被包裹的密钥一样长（1、16、32、64 字节），node:crypto 用主密钥、AAD = keyId 独立解开正好是那把密钥；node:crypto 按同一格式包裹的文本 unwrapKey 也还原得出', async () => {
  const master = testKey(MASTER_A);
  const provider = new LocalKeyProvider(master, 'local-dev');
  const keys = [testBytes(3, 1), testBytes(4, 16), testKey(1), testBytes(5, 64)];
  const written: Record<string, unknown>[] = [];
  const readBack: string[] = [];
  for (const key of keys) {
    const wrapped = await provider.wrapKey(key);
    written.push({
      shape: /^lk1\.[A-Za-z0-9_-]+$/.test(wrapped),
      payloadBytes: parseLk1(wrapped).length,
      byNodeCrypto: referenceUnwrap(master, 'local-dev', wrapped).toString('hex'),
      byProvider: Buffer.from(await provider.unwrapKey(wrapped)).toString('hex'),
    });
    const fromReference = referenceWrap(master, 'local-dev', key);
    readBack.push(Buffer.from(await provider.unwrapKey(fromReference)).toString('hex'));
  }
  expect({ keyId: provider.keyId, written, readBack }).toEqual({
    keyId: 'local-dev',
    written: keys.map((key) => ({
      shape: true,
      payloadBytes: IV_BYTES + key.length + TAG_BYTES,
      byNodeCrypto: key.toString('hex'),
      byProvider: key.toString('hex'),
    })),
    readBack: keys.map((key) => key.toString('hex')),
  });
});

it('[BR-ID-33] LocalKeyProvider 每次包裹都用新的随机 IV：同一把主密钥把同一把密钥包裹 20 次（一个实例 10 次、同一主密钥的另一个实例 10 次），20 份 lk1 文本的 IV 两两不同，每份都正好解出那把密钥', async () => {
  // AES-256-GCM under one master key: a fixed or repeated IV would let two wrapped keys be
  // combined into the plaintext of one another. The IV is read from the format, so a fixed IV
  // hidden behind a random suffix shows.
  const master = testKey(MASTER_A);
  const first = new LocalKeyProvider(master, 'local-dev');
  const second = new LocalKeyProvider(Buffer.from(master), 'local-dev');
  const key = testKey(1);
  const wrapped: string[] = [];
  for (let i = 0; i < 10; i += 1) wrapped.push(await first.wrapKey(key));
  for (let i = 0; i < 10; i += 1) wrapped.push(await second.wrapKey(key));
  expect({
    distinctIvs: new Set(wrapped.map((text) => ivOfLk1(text).toString('hex'))).size,
    unwrapped: wrapped.map((text) => referenceUnwrap(master, 'local-dev', text).toString('hex')),
  }).toEqual({ distinctIvs: 20, unwrapped: wrapped.map(() => key.toString('hex')) });
});

it('[BR-ID-33] LocalKeyProvider 的主密钥必须是 32 字节（AES-256）：0、16、31、33、64 字节一律 invalid_key', () => {
  const lengths = [0, 16, 31, 33, 64];
  expect({
    bad: lengths.map((length) => outcomeOf(() => new LocalKeyProvider(testBytes(5, length)))),
    good: outcomeOf(() => new LocalKeyProvider(testBytes(5, 32), 'local-dev')),
    keyId: new LocalKeyProvider(testBytes(5, 32), 'local-dev').keyId,
  }).toEqual({ bad: lengths.map(() => 'invalid_key'), good: 'returned', keyId: 'local-dev' });
});

it('[BR-ID-33] LocalKeyProvider 不返回错误的密钥：换一把主密钥、换一个 keyId、包裹文本被改动一个字符，unwrapKey 以 decrypt_failed 拒绝；不是 lk1.<payload> 的文本（空串、十六进制、别的前缀、带换行或补位、载荷不足 12 + 1 + 16 字节）以 invalid_keyring 拒绝', async () => {
  const master = testKey(MASTER_A);
  const a = new LocalKeyProvider(master, 'local-dev');
  const wrapped = await a.wrapKey(testKey(1));
  const payload = parseLk1(wrapped);
  const altered = Buffer.from(payload);
  altered[IV_BYTES + 3] = (altered[IV_BYTES + 3] ?? 0) ^ 0x01;
  const attempts: Record<string, () => Promise<Uint8Array>> = {
    otherMasterKey: () => new LocalKeyProvider(testKey(MASTER_B), 'local-dev').unwrapKey(wrapped),
    otherKeyId: () => new LocalKeyProvider(master, 'local-other').unwrapKey(wrapped),
    alteredByte: () => a.unwrapKey(`lk1.${b64url(altered)}`),
    alteredIv: () =>
      a.unwrapKey(
        `lk1.${b64url(Buffer.concat([Buffer.alloc(IV_BYTES), payload.subarray(IV_BYTES)]))}`,
      ),
    empty: () => a.unwrapKey(''),
    hex: () => a.unwrapKey(testKey(1).toString('hex')),
    otherPrefix: () => a.unwrapKey(`lk2.${b64url(payload)}`),
    noPrefix: () => a.unwrapKey(b64url(payload)),
    trailingNewline: () => a.unwrapKey(`${wrapped}\n`),
    padded: () => a.unwrapKey(`${wrapped}=`),
    payloadTooShort: () => a.unwrapKey(`lk1.${b64url(payload.subarray(0, IV_BYTES + TAG_BYTES))}`),
  };
  const outcomes: Record<string, string> = {};
  for (const [name, attempt] of Object.entries(attempts)) {
    outcomes[name] = await rejectionOf(attempt);
  }
  expect({
    sameMasterKey: Buffer.from(await a.unwrapKey(wrapped)).equals(testKey(1)),
    outcomes,
  }).toEqual({
    sameMasterKey: true,
    outcomes: {
      otherMasterKey: 'decrypt_failed',
      otherKeyId: 'decrypt_failed',
      alteredByte: 'decrypt_failed',
      alteredIv: 'decrypt_failed',
      empty: 'invalid_keyring',
      hex: 'invalid_keyring',
      otherPrefix: 'invalid_keyring',
      noPrefix: 'invalid_keyring',
      trailingNewline: 'invalid_keyring',
      padded: 'invalid_keyring',
      payloadTooShort: 'invalid_keyring',
    },
  });
});

it('[BR-ID-33] 本地走的是同一条信封路径：LocalKeyProvider 建 keyring、存成 JSON 再读回、轮换、打开，加密解密与盲索引都成立', async () => {
  const provider = new LocalKeyProvider(testKey(MASTER_A), 'local-dev');
  const created = await createWrappedKeyring(provider);
  // The keyring is a plain JSON document: what is stored is what is opened later.
  const stored = JSON.parse(JSON.stringify(created)) as WrappedKeyring;
  const first = await openFieldCrypto(stored, provider);
  const ciphertext = first.encrypt(SAMPLES.phone, 'users.phone');
  const index = first.blindIndex(SAMPLES.phone, 'users.phone');

  const rotated = JSON.parse(
    JSON.stringify(await rotateDataKey(stored, provider)),
  ) as WrappedKeyring;
  const second = await openFieldCrypto(rotated, provider);
  const blindKey = await provider.unwrapKey(stored.blind_index_key);
  expect({
    keyId: stored.key_id,
    storedEqualsCreated: stored,
    firstVersion: first.keyVersionOf(ciphertext),
    decryptedAfterRotation: second.decrypt(ciphertext, 'users.phone'),
    secondVersion: second.keyVersionOf(second.encrypt(SAMPLES.phone, 'users.phone')),
    index,
    indexAfterRotation: second.blindIndex(SAMPLES.phone, 'users.phone'),
  }).toEqual({
    keyId: 'local-dev',
    storedEqualsCreated: created,
    firstVersion: 1,
    decryptedAfterRotation: SAMPLES.phone,
    secondVersion: 2,
    index: referenceBlindIndex(blindKey, SAMPLES.phone, 'users.phone'),
    indexAfterRotation: index,
  });
});

it('[BR-ID-33] 进程重启后照常可用：用同一把主密钥、同一 keyId 新建的 LocalKeyProvider 能打开存下来的 keyring，解开重启前各版本的密文，盲索引不变', async () => {
  const beforeRestart = new LocalKeyProvider(testKey(MASTER_A), 'local-dev');
  const created = await createWrappedKeyring(beforeRestart);
  const firstCrypto = await openFieldCrypto(created, beforeRestart);
  const version1 = firstCrypto.encrypt(SAMPLES.idNo, 'realname.id_no');
  const index = firstCrypto.blindIndex(SAMPLES.idNo, 'realname.id_no');
  const rotated = await rotateDataKey(created, beforeRestart);
  const version2 = (await openFieldCrypto(rotated, beforeRestart)).encrypt(
    SAMPLES.idNo,
    'realname.id_no',
  );
  const looseWrapped = await beforeRestart.wrapKey(testKey(1));
  // Only text survives a restart: the stored keyring and the wrapped key.
  const storedKeyring = JSON.stringify(rotated);

  // A new provider object built from the same master key bytes: nothing of the old instance
  // (no in-memory table of wrapped keys) is available to it.
  const afterRestart = new LocalKeyProvider(Buffer.from(testKey(MASTER_A)), 'local-dev');
  const crypto = await openFieldCrypto(JSON.parse(storedKeyring) as WrappedKeyring, afterRestart);
  expect({
    versions: [crypto.keyVersionOf(version1), crypto.keyVersionOf(version2)],
    version1: crypto.decrypt(version1, 'realname.id_no'),
    version2: crypto.decrypt(version2, 'realname.id_no'),
    index: crypto.blindIndex(SAMPLES.idNo, 'realname.id_no'),
    looseKey: Buffer.from(await afterRestart.unwrapKey(looseWrapped)).equals(testKey(1)),
    // And the other way round: what the new instance wraps, the old one unwraps.
    wrappedAfterRestart: Buffer.from(
      await beforeRestart.unwrapKey(await afterRestart.wrapKey(testKey(2))),
    ).equals(testKey(2)),
  }).toEqual({
    versions: [1, 2],
    version1: SAMPLES.idNo,
    version2: SAMPLES.idNo,
    index,
    looseKey: true,
    wrappedAfterRestart: true,
  });
});

it('[BR-ID-33] 主密钥不对就打不开 keyring：另一把主密钥的 LocalKeyProvider（keyId 相同）解不开包裹，打开时以 key_provider_failed 拒绝，拿不到任何可用的密钥', async () => {
  const right = new LocalKeyProvider(testKey(MASTER_A), 'local-dev');
  const wrong = new LocalKeyProvider(testKey(MASTER_B), 'local-dev');
  const doc = await createWrappedKeyring(right);
  expect({
    right: await rejectionOf(() => openFieldCrypto(doc, right)),
    wrong: await rejectionOf(() => openFieldCrypto(doc, wrong)),
  }).toEqual({ right: 'resolved', wrong: 'key_provider_failed' });
});
