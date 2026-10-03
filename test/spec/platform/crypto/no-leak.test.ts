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
  referenceEncrypt,
  testKey,
} from './kit.ts';

// Distinctive synthetic values: none of them is a substring of an error message by accident.
const SECRET_PLAINTEXT = '13877776666';
const SECRET_ID_NO = '11010519491231002X';

/**
 * Each named value as text and as its UTF-8 bytes: kept bytes print as hex (inspect of a
 * Buffer), as a number array (JSON, inspect of a Uint8Array) or as base64, never as the text
 * itself; leaksIn checks every encoding of a byte secret.
 */
function withBytes(values: Readonly<Record<string, string>>): Record<string, string | Uint8Array> {
  const secrets: Record<string, string | Uint8Array> = { ...values };
  for (const [name, value] of Object.entries(values)) {
    secrets[`${name} (utf-8)`] = Buffer.from(value, 'utf8');
  }
  return secrets;
}

it('[BR-ID-33] 报错不带明文：加密、建索引被拒时，错误的 message、stack、JSON 与 inspect 输出里都找不到传入的值，字符串与 UTF-8 字节的各种编码都没有', async () => {
  const kms = new FakeKms();
  const crypto = await openFieldCrypto(knownKeyring(kms, [1], 1).doc, kms);
  const secrets = withBytes({ plaintext: SECRET_PLAINTEXT, idNo: SECRET_ID_NO });
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

it('[BR-ID-33] 解密失败的报错不带明文也不带密钥：密文被改、context 不对、版本不存在时，错误输出里找不到原文（字符串与 UTF-8 字节）与任何密钥字节', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1, 2], 2);
  const crypto = await openFieldCrypto(known.doc, kms);
  const ciphertext = crypto.encrypt(SECRET_PLAINTEXT, 'users.phone');
  const secrets = {
    ...withBytes({ plaintext: SECRET_PLAINTEXT }),
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

it('[BR-ID-33] 用过的 FieldCrypto 不留明文：加密、解密、重新加密、建索引成功之后，对象的 JSON 与 inspect 输出里找不到经手的手机号、身份证号、收款账号，原文字符串与 UTF-8 字节的十六进制、base64、数字数组形式都没有', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1, 2], 2);
  const crypto = await openFieldCrypto(known.doc, kms);
  const values = {
    phone: '13877776666',
    idNo: '11010519491231002X',
    alipay: 'payee-rule-test@example.com',
    bankCard: '6200000000000077777',
  };
  const secrets = withBytes(values);
  // The check itself must see bytes: an object that keeps them in a public property, in any
  // of the usual forms, is reported.
  const keepsBytes = {
    lastPlaintext: Buffer.from(values.phone, 'utf8'),
    lastIdNo: new Uint8Array(Buffer.from(values.idNo, 'utf8')),
    lastPayeeHex: Buffer.from(values.alipay, 'utf8').toString('hex'),
    lastCardBase64: Buffer.from(values.bankCard, 'utf8').toString('base64'),
  };
  const leaksAfter: Record<string, string[]> = {};
  const check = (step: string): void => {
    leaksAfter[step] = leaksIn({ crypto, methods: [crypto.encrypt, crypto.decrypt] }, secrets);
  };
  const phoneCiphertext = crypto.encrypt(values.phone, 'users.phone');
  check('encrypt');
  const decrypted = crypto.decrypt(phoneCiphertext, 'users.phone');
  check('decrypt');
  crypto.blindIndex(values.idNo, 'realname.id_no');
  check('blindIndex');
  const old = referenceEncrypt(known.dataKey(1), 1, values.alipay, 'payout_accounts.alipay');
  const reencrypted = crypto.reencrypt(old, 'payout_accounts.alipay');
  check('reencrypt');
  crypto.encrypt(values.bankCard, 'payout_accounts.bank_card');
  crypto.blindIndex(values.bankCard, 'payout_accounts.bank_card');
  check('afterEverything');
  expect({
    decrypted,
    reencrypted: crypto.decrypt(reencrypted, 'payout_accounts.alipay'),
    leaksAfter,
    checkSeesKeptBytes: leaksIn(keepsBytes, secrets),
  }).toEqual({
    decrypted: values.phone,
    reencrypted: values.alipay,
    leaksAfter: { encrypt: [], decrypt: [], blindIndex: [], reencrypt: [], afterEverything: [] },
    checkSeesKeptBytes: ['phone (utf-8)', 'idNo (utf-8)', 'alipay (utf-8)', 'bankCard (utf-8)'],
  });
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
