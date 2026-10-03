// Rule tests for 规划/08 BR-ID-33: 接口、H5、列表、日志、Sentry … 中不得出现明文。Inside this
// module that means: an error it throws, and the objects it hands out, can be logged or sent to
// the error tracker without revealing a plaintext, a value being indexed, or the keys that would
// decrypt every stored value. "Printed" below covers what a logger can produce from a value:
// util.inspect (hidden properties, unlimited depth), JSON.stringify, and for errors the
// message, the stack and String(error). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  BLIND_KEY_LABEL,
  FakeKms,
  SAMPLES,
  errorOf,
  flipPayloadBit,
  knownKeyring,
  leaksIn,
  testKey,
} from './kit.ts';

// Distinctive synthetic values: none of them is a substring of an error message by accident.
const SECRET_PLAINTEXT = '13877776666';
const SECRET_ID_NO = '11010519491231002X';

it('[BR-ID-33] 报错不带明文：加密、建索引被拒时，错误的 message、stack、JSON 与 inspect 输出里都找不到传入的值', async () => {
  const kms = new FakeKms();
  const crypto = await openFieldCrypto(knownKeyring(kms, [1], 1).doc, kms);
  const secrets = { plaintext: SECRET_PLAINTEXT, idNo: SECRET_ID_NO };
  const errors: Record<string, unknown> = {
    encryptBadContext: errorOf(() => crypto.encrypt(SECRET_PLAINTEXT, 'users phone')),
    encryptEmptyContext: errorOf(() => crypto.encrypt(SECRET_ID_NO, '')),
    encryptIllFormed: errorOf(() => crypto.encrypt(`${SECRET_PLAINTEXT}\ud800`, 'users.phone')),
    blindIndexBadContext: errorOf(() => crypto.blindIndex(SECRET_ID_NO, 'realname id_no')),
    blindIndexIllFormed: errorOf(() =>
      crypto.blindIndex(`${SECRET_ID_NO}\udc00`, 'realname.id_no'),
    ),
    // A caller that mixes the arguments up: the value arrives where the context belongs.
    encryptSwappedArguments: errorOf(() => crypto.encrypt('users.phone', `${SECRET_PLAINTEXT} `)),
  };
  expect(
    Object.fromEntries(
      Object.entries(errors).map(([name, error]) => [name, leaksIn(error, secrets)]),
    ),
  ).toEqual(Object.fromEntries(Object.keys(errors).map((name) => [name, []])));
});

it('[BR-ID-33] 解密失败的报错不带明文也不带密钥：密文被改、context 不对、版本不存在时，错误输出里找不到原文与任何密钥字节', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1, 2], 2);
  const crypto = await openFieldCrypto(known.doc, kms);
  const ciphertext = crypto.encrypt(SECRET_PLAINTEXT, 'users.phone');
  const secrets = {
    plaintext: SECRET_PLAINTEXT,
    dataKey1: known.dataKey(1),
    dataKey2: known.dataKey(2),
    blindKey: known.blindKey,
  };
  const errors: Record<string, unknown> = {
    wrongContext: errorOf(() => crypto.decrypt(ciphertext, 'users.mobile')),
    tampered: errorOf(() => crypto.decrypt(flipPayloadBit(ciphertext, 100), 'users.phone')),
    unknownVersion: errorOf(() =>
      crypto.decrypt(ciphertext.replace('v1.2.', 'v1.8.'), 'users.phone'),
    ),
    malformed: errorOf(() => crypto.decrypt(SECRET_PLAINTEXT, 'users.phone')),
    reencryptWrongContext: errorOf(() => crypto.reencrypt(ciphertext, 'users.mobile')),
  };
  expect(
    Object.fromEntries(
      Object.entries(errors).map(([name, error]) => [name, leaksIn(error, secrets)]),
    ),
  ).toEqual({
    wrongContext: [],
    tampered: [],
    unknownVersion: [],
    // Text that is not a ciphertext may be a plaintext stored unencrypted by mistake.
    malformed: [],
    reencryptWrongContext: [],
  });
});

it('[BR-ID-33] FieldCrypto 对象进日志不泄密钥：JSON.stringify 与 util.inspect（含隐藏属性、不限深度）的输出里找不到任何密钥字节的编码', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1, 2, 3], 3);
  const crypto = await openFieldCrypto(known.doc, kms);
  // Use it once, in case keys are only materialised on first use.
  const ciphertext = crypto.encrypt(SAMPLES.phone, 'users.phone');
  crypto.blindIndex(SAMPLES.phone, 'users.phone');
  const secrets = {
    dataKey1: known.dataKey(1),
    dataKey2: known.dataKey(2),
    dataKey3: known.dataKey(3),
    blindKey: testKey(BLIND_KEY_LABEL),
  };
  expect({
    stillWorks: crypto.decrypt(ciphertext, 'users.phone'),
    object: leaksIn(crypto, secrets),
    methods: leaksIn(
      [crypto.encrypt, crypto.decrypt, crypto.blindIndex, crypto.reencrypt, crypto.keyVersionOf],
      secrets,
    ),
    wrapped: leaksIn({ crypto, note: 'as a logger would receive it' }, secrets),
  }).toEqual({ stillWorks: SAMPLES.phone, object: [], methods: [], wrapped: [] });
});

it('[BR-ID-33] LocalKeyProvider 对象进日志不泄主密钥，也不泄经它包裹、解包过的密钥；用它打开的 FieldCrypto 同样不泄', async () => {
  const masterKey = testKey(240);
  const provider = new LocalKeyProvider(masterKey, 'local-dev');
  const doc = await createWrappedKeyring(provider);
  const handled = testKey(1);
  await provider.unwrapKey(await provider.wrapKey(handled));
  const crypto = await openFieldCrypto(doc, provider);
  crypto.blindIndex(SAMPLES.phone, 'users.phone');
  const secrets = {
    masterKey,
    handledKey: handled,
    dataKey: await provider.unwrapKey(doc.data_keys[0]?.wrapped ?? ''),
    blindKey: await provider.unwrapKey(doc.blind_index_key),
  };
  expect({
    keyId: provider.keyId,
    provider: leaksIn(provider, secrets),
    cryptoOpenedWithIt: leaksIn(crypto, secrets),
    roundTrip: crypto.decrypt(crypto.encrypt(SAMPLES.phone, 'users.phone'), 'users.phone'),
  }).toEqual({
    keyId: 'local-dev',
    provider: [],
    cryptoOpenedWithIt: [],
    roundTrip: SAMPLES.phone,
  });
});
