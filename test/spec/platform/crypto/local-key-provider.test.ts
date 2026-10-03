// Rule tests for 规划/08 BR-ID-33 (KMS 信封加密) on the local side: ADR-0001 §2 鉴权与密钥 says
// the KeyProvider is a file / in-memory key locally and KMS in the cloud. LocalKeyProvider is
// the local one: it must behave like a master key holder (wrap, unwrap, refuse foreign or
// altered text), so that local and test runs go through the same envelope path as production.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  FieldCryptoError,
  LocalKeyProvider,
  type WrappedKeyring,
  createWrappedKeyring,
  openFieldCrypto,
  rotateDataKey,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  SAMPLES,
  encodingsOf,
  outcomeOf,
  referenceBlindIndex,
  rejectionOf,
  testBytes,
  testKey,
} from './kit.ts';

const MASTER_A = 240;
const MASTER_B = 241;

/** One character of `text` replaced so that the decoded value differs or the text is invalid. */
function alterOneCharacter(text: string): string {
  for (let at = Math.floor(text.length / 2); at < text.length; at += 1) {
    const ch = text[at] ?? '';
    let replacement: string | null = null;
    if (/[0-9]/.test(ch)) replacement = String((Number(ch) + 1) % 10);
    else if (/[a-y]/.test(ch) || /[A-Y]/.test(ch)) {
      replacement = String.fromCharCode(ch.charCodeAt(0) + 1);
    } else if (ch === 'z') replacement = 'a';
    else if (ch === 'Z') replacement = 'A';
    if (replacement !== null) return text.slice(0, at) + replacement + text.slice(at + 1);
  }
  throw new Error('no letter or digit to alter in the second half of the text');
}

it('[BR-ID-33] LocalKeyProvider：wrapKey 之后 unwrapKey 还原出同一把密钥，包裹文本里找不到明文密钥与主密钥的编码', async () => {
  const provider = new LocalKeyProvider(testKey(MASTER_A));
  const keys = [testKey(1), testBytes(3, 32), testBytes(4, 64)];
  const restored: string[] = [];
  const leaked: string[] = [];
  for (const key of keys) {
    const wrapped = await provider.wrapKey(key);
    restored.push(Buffer.from(await provider.unwrapKey(wrapped)).toString('hex'));
    const text = wrapped.toLowerCase();
    for (const secret of [key, testKey(MASTER_A)]) {
      leaked.push(...encodingsOf(secret).filter((e) => text.includes(e.toLowerCase())));
    }
  }
  expect({ keyId: provider.keyId, restored, leaked }).toEqual({
    keyId: 'local',
    restored: keys.map((key) => key.toString('hex')),
    leaked: [],
  });
});

it('[BR-ID-33] LocalKeyProvider 的主密钥必须是 32 字节（AES-256）：0、16、31、33、64 字节一律 invalid_key', () => {
  const lengths = [0, 16, 31, 33, 64];
  expect({
    bad: lengths.map((length) => outcomeOf(() => new LocalKeyProvider(testBytes(5, length)))),
    good: outcomeOf(() => new LocalKeyProvider(testBytes(5, 32), 'local-dev')),
    keyId: new LocalKeyProvider(testBytes(5, 32), 'local-dev').keyId,
  }).toEqual({ bad: lengths.map(() => 'invalid_key'), good: 'returned', keyId: 'local-dev' });
});

it('[BR-ID-33] LocalKeyProvider：换一把主密钥、或包裹文本被改动，unwrapKey 以 FieldCryptoError 拒绝，不返回错误的密钥', async () => {
  const a = new LocalKeyProvider(testKey(MASTER_A));
  const b = new LocalKeyProvider(testKey(MASTER_B));
  const wrapped = await a.wrapKey(testKey(1));
  const attempts: Record<string, () => Promise<Uint8Array>> = {
    otherMasterKey: () => b.unwrapKey(wrapped),
    alteredText: () => a.unwrapKey(alterOneCharacter(wrapped)),
    truncatedText: () => a.unwrapKey(wrapped.slice(0, Math.floor(wrapped.length / 2))),
    emptyText: () => a.unwrapKey(''),
    notWrappedAtAll: () => a.unwrapKey(testKey(1).toString('hex')),
  };
  const refused: Record<string, boolean> = {};
  for (const [name, attempt] of Object.entries(attempts)) {
    refused[name] = await attempt().then(
      () => false,
      (error: unknown) => error instanceof FieldCryptoError,
    );
  }
  expect({
    sameMasterKey: Buffer.from(await a.unwrapKey(wrapped)).equals(testKey(1)),
    refused,
  }).toEqual({
    sameMasterKey: true,
    refused: Object.fromEntries(Object.keys(attempts).map((name) => [name, true])),
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

it('[BR-ID-33] 主密钥不对就打不开 keyring：另一把主密钥的 LocalKeyProvider（keyId 相同）打开时被拒绝，拿不到任何可用的密钥', async () => {
  const right = new LocalKeyProvider(testKey(MASTER_A), 'local-dev');
  const wrong = new LocalKeyProvider(testKey(MASTER_B), 'local-dev');
  const doc = await createWrappedKeyring(right);
  expect({
    right: await rejectionOf(() => openFieldCrypto(doc, right)),
    wrongIsRefused: await openFieldCrypto(doc, wrong).then(
      () => false,
      (error: unknown) => error instanceof FieldCryptoError,
    ),
  }).toEqual({ right: 'resolved', wrongIsRefused: true });
});
