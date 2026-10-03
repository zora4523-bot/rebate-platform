// Rule tests for 规划/08 BR-ID-33: 接口、H5、列表、日志、Sentry … 中不得出现明文。Inside this
// module that means: an error it throws, and the objects it hands out, can be logged or sent to
// the error tracker without revealing a plaintext, a value being indexed, or the keys that would
// decrypt every stored value. The contract makes both exact, so the tests compare exactly: an
// error is a FieldCryptoError with the fixed message of its code, a plain stack and no other
// property; a LocalKeyProvider has only `keyId`, a FieldCrypto only `currentKeyVersion` and its
// methods, and neither is a Proxy. As a second net, every printed form (util.inspect with hidden
// properties and unlimited depth, JSON.stringify, for errors also message, stack and
// String(error)) is searched for the plaintexts and keys, as text and as bytes.
// What a process prints is checked in restart.test.ts. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  type FieldCryptoErrorCode,
  LocalKeyProvider,
  type WrappedKeyring,
  createWrappedKeyring,
  openFieldCrypto,
  rotateDataKey,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  BLIND_KEY_LABEL,
  FakeKms,
  SAMPLES,
  errorProblems,
  fakeWrap,
  flipPayloadBit,
  knownKeyring,
  leaksIn,
  referenceEncrypt,
  referenceUnwrap,
  referenceWrap,
  shapeProblems,
  testBytes,
  testKey,
  withBytes,
} from './kit.ts';

// Distinctive synthetic values: none of them is a substring of an error message by accident.
const SECRET_PLAINTEXT = '13877776666';
const SECRET_ID_NO = '11010519491231002X';

/** The error a call throws or rejects with; a call that succeeds yields a marker string. */
async function failureOf(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return 'the call succeeded';
}

it('[BR-ID-33] 报错不带明文也不带密钥：每一种被拒的调用（加密、建索引、解密、重新加密、读版本、打开与轮换 keyring、本地主密钥与解包）抛出的都正好是 FieldCryptoError：该错误码的固定文案、普通的堆栈、除 code 外没有别的属性（没有 cause），各种输出形式里也找不到传入的值与任何密钥', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1, 2], 2);
  const crypto = await openFieldCrypto(known.doc, kms);
  const ciphertext = crypto.encrypt(SECRET_PLAINTEXT, 'users.phone');
  const master = testKey(240);
  const local = new LocalKeyProvider(master, 'local-dev');
  const wrapped = await local.wrapKey(testKey(1));
  const shortKeyring: WrappedKeyring = {
    ...known.doc,
    data_keys: [{ version: 1, wrapped: fakeWrap(testBytes(9, 16), kms.keyId) }],
    current_version: 1,
  };
  const cases: Record<string, [FieldCryptoErrorCode, () => unknown]> = {
    encryptBadContext: ['invalid_context', () => crypto.encrypt(SECRET_PLAINTEXT, 'users phone')],
    encryptEmptyContext: ['invalid_context', () => crypto.encrypt(SECRET_ID_NO, '')],
    // A caller that mixes the arguments up: the value arrives where the context belongs.
    encryptSwapped: [
      'invalid_context',
      () => crypto.encrypt('users.phone', `${SECRET_PLAINTEXT} `),
    ],
    encryptIllFormed: ['invalid_plaintext', () => crypto.encrypt(`${SECRET_PLAINTEXT}\ud800`, 'x')],
    indexBadContext: ['invalid_context', () => crypto.blindIndex(SECRET_ID_NO, 'realname id_no')],
    indexIllFormed: ['invalid_plaintext', () => crypto.blindIndex(`${SECRET_ID_NO}\udc00`, 'x')],
    decryptWrongContext: ['decrypt_failed', () => crypto.decrypt(ciphertext, 'users.mobile')],
    decryptTampered: [
      'decrypt_failed',
      () => crypto.decrypt(flipPayloadBit(ciphertext, 100), 'users.phone'),
    ],
    decryptUnknownVersion: [
      'unknown_key_version',
      () => crypto.decrypt(ciphertext.replace('v1.2.', 'v1.8.'), 'users.phone'),
    ],
    // Text that is not a ciphertext may be a plaintext stored unencrypted by mistake.
    decryptPlaintext: [
      'malformed_ciphertext',
      () => crypto.decrypt(SECRET_PLAINTEXT, 'users.phone'),
    ],
    versionOfPlaintext: ['malformed_ciphertext', () => crypto.keyVersionOf(SECRET_ID_NO)],
    reencryptWrongContext: ['decrypt_failed', () => crypto.reencrypt(ciphertext, 'users.mobile')],
    openNoDataKey: ['invalid_keyring', () => openFieldCrypto({ ...known.doc, data_keys: [] }, kms)],
    openOtherKeyId: [
      'invalid_keyring',
      () => openFieldCrypto({ ...known.doc, key_id: 'fake-kms/master-b' }, kms),
    ],
    openShortDataKey: ['invalid_key', () => openFieldCrypto(shortKeyring, kms)],
    rotateOtherKeyId: [
      'invalid_keyring',
      () => rotateDataKey({ ...known.doc, key_id: 'fake-kms/master-b' }, kms),
    ],
    localShortMaster: ['invalid_key', () => new LocalKeyProvider(testBytes(5, 16), 'local-dev')],
    unwrapNotWrapped: ['invalid_keyring', () => local.unwrapKey(testKey(1).toString('hex'))],
    unwrapOtherMaster: [
      'decrypt_failed',
      () => new LocalKeyProvider(testKey(241), 'local-dev').unwrapKey(wrapped),
    ],
    unwrapOtherKeyId: [
      'decrypt_failed',
      () => new LocalKeyProvider(master, 'other').unwrapKey(wrapped),
    ],
  };
  const secrets = {
    ...withBytes({ plaintext: SECRET_PLAINTEXT, idNo: SECRET_ID_NO }),
    dataKey1: known.dataKey(1),
    dataKey2: known.dataKey(2),
    blindKey: known.blindKey,
    masterKey: master,
    wrappedKey: testKey(1),
  };
  const problems: Record<string, string[]> = {};
  const leaks: Record<string, string[]> = {};
  for (const [name, [code, run]] of Object.entries(cases)) {
    const error = await failureOf(run);
    problems[name] = errorProblems(error, code);
    leaks[name] = leaksIn(error, secrets);
  }
  const none = Object.fromEntries(Object.keys(cases).map((name) => [name, []]));
  expect({ problems, leaks }).toEqual({ problems: none, leaks: none });
});

it('[BR-ID-33] FieldCrypto 进日志既不泄密钥也不留明文：打开后、加密、解密、重新加密、建索引之后，对象只有 currentKeyVersion 和六个方法（不是 Proxy、方法上没有附带数据），JSON 与 inspect（含隐藏属性、不限深度）里找不到任何密钥与经手的手机号、身份证号、收款账号（原文与 UTF-8 字节的各种编码）', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1, 2, 3], 3);
  const crypto = await openFieldCrypto(known.doc, kms);
  const values = {
    phone: '13877776666',
    idNo: '11010519491231002X',
    alipay: 'payee-rule-test@example.com',
    bankCard: '6200000000000077777',
  };
  const secrets = {
    ...withBytes(values),
    dataKey1: known.dataKey(1),
    dataKey2: known.dataKey(2),
    dataKey3: known.dataKey(3),
    blindKey: testKey(BLIND_KEY_LABEL),
  };
  const shape: Record<string, string[]> = {};
  const leaksAfter: Record<string, string[]> = {};
  const check = (step: string): void => {
    shape[step] = shapeProblems(crypto, { fieldCrypto: 3 });
    leaksAfter[step] = leaksIn(
      { crypto, methods: [crypto.encrypt, crypto.decrypt, crypto.blindIndex, crypto.reencrypt] },
      secrets,
    );
  };
  check('opened');
  const phone = crypto.encrypt(values.phone, 'users.phone');
  check('encrypt');
  const decrypted = crypto.decrypt(phone, 'users.phone');
  check('decrypt');
  crypto.blindIndex(values.idNo, 'realname.id_no');
  check('blindIndex');
  const old = referenceEncrypt(known.dataKey(1), 1, values.alipay, 'payout_accounts.alipay');
  const reencrypted = crypto.reencrypt(old, 'payout_accounts.alipay');
  check('reencrypt');
  crypto.encrypt(values.bankCard, 'payout_accounts.bank_card');
  crypto.blindIndex(values.bankCard, 'payout_accounts.bank_card');
  check('afterEverything');
  // The second net must see bytes: an object that keeps them in a property, in any of the usual
  // forms, is reported (Buffer, Uint8Array, hex, base64; inspect output spans several lines).
  const keepsBytes = {
    lastPlaintext: Buffer.from(values.phone, 'utf8'),
    lastIdNo: new Uint8Array(Buffer.from(values.idNo, 'utf8')),
    lastPayeeHex: Buffer.from(values.alipay, 'utf8').toString('hex'),
    lastCardBase64: Buffer.from(values.bankCard, 'utf8').toString('base64'),
    key: new Uint8Array(known.dataKey(3)),
  };
  const steps = ['opened', 'encrypt', 'decrypt', 'blindIndex', 'reencrypt', 'afterEverything'];
  expect({
    decrypted,
    reencrypted: crypto.decrypt(reencrypted, 'payout_accounts.alipay'),
    shape,
    leaksAfter,
    secondNetSeesKeptBytes: leaksIn(keepsBytes, secrets),
  }).toEqual({
    decrypted: values.phone,
    reencrypted: values.alipay,
    shape: Object.fromEntries(steps.map((step) => [step, []])),
    leaksAfter: Object.fromEntries(steps.map((step) => [step, []])),
    secondNetSeesKeptBytes: [
      'phone (utf-8)',
      'idNo (utf-8)',
      'alipay (utf-8)',
      'bankCard (utf-8)',
      'dataKey3',
    ],
  });
});

it('[BR-ID-33] LocalKeyProvider 进日志不泄主密钥，也不泄经它包裹、解包过的密钥：建好、包裹、解包、建 keyring、轮换之后对象只有 keyId 一个自有属性（不是 Proxy），用它打开的 FieldCrypto 同样只有约定的属性；各种输出形式里找不到这些密钥', async () => {
  const masterKey = testKey(240);
  const provider = new LocalKeyProvider(masterKey, 'local-dev');
  const shape: Record<string, string[]> = {
    constructed: shapeProblems(provider, { provider: 'local-dev' }),
  };
  const handled = testKey(1);
  await provider.unwrapKey(await provider.wrapKey(handled));
  await provider.unwrapKey(referenceWrap(masterKey, 'local-dev', testKey(2)));
  shape['wrapUnwrap'] = shapeProblems(provider, { provider: 'local-dev' });
  const doc = await rotateDataKey(await createWrappedKeyring(provider), provider);
  shape['keyring'] = shapeProblems(provider, { provider: 'local-dev' });
  const crypto = await openFieldCrypto(doc, provider);
  crypto.blindIndex(SAMPLES.phone, 'users.phone');
  const secrets = {
    masterKey,
    handledKey: handled,
    referenceWrappedKey: testKey(2),
    dataKey1: referenceUnwrap(masterKey, 'local-dev', doc.data_keys[0]?.wrapped ?? ''),
    dataKey2: referenceUnwrap(masterKey, 'local-dev', doc.data_keys[1]?.wrapped ?? ''),
    blindKey: referenceUnwrap(masterKey, 'local-dev', doc.blind_index_key),
  };
  expect({
    keyId: provider.keyId,
    shape,
    cryptoShape: shapeProblems(crypto, { fieldCrypto: 2 }),
    provider: leaksIn(provider, secrets),
    cryptoOpenedWithIt: leaksIn(crypto, secrets),
    roundTrip: crypto.decrypt(crypto.encrypt(SAMPLES.phone, 'users.phone'), 'users.phone'),
  }).toEqual({
    keyId: 'local-dev',
    shape: { constructed: [], wrapUnwrap: [], keyring: [] },
    cryptoShape: [],
    provider: [],
    cryptoOpenedWithIt: [],
    roundTrip: SAMPLES.phone,
  });
});
