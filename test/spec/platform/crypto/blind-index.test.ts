// Rule tests for 规划/08 BR-ID-33, the blind-index clause: 另存 HMAC 盲索引用于去重与查询。
// De-duplication and lookup need a value that is the same every time for the same input, differs
// for different inputs, and survives a rotation of the data keys; the persisted form is the one
// written in the header of apps/api/src/modules/platform/crypto/index.ts:
// lowercase hex of HMAC-SHA256(blind_index_key, utf8(context) ‖ 0x00 ‖ utf8(value)).
// Expected values are computed with node:crypto in kit.ts. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  openFieldCrypto,
  rotateDataKey,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  BLIND_KEY_LABEL,
  FakeKms,
  SAMPLES,
  knownKeyring,
  outcomeOf,
  referenceBlindIndex,
  testKey,
} from './kit.ts';

const CASES: readonly (readonly [value: string, context: string])[] = [
  [SAMPLES.phone, 'users.phone'],
  [SAMPLES.idNo, 'realname.id_no'],
  [SAMPLES.alipay, 'payout_accounts.alipay'],
  [SAMPLES.bankCard, 'payout_accounts.bank_card'],
  [SAMPLES.name, 'realname.name'],
  [SAMPLES.astral, 'payout_accounts.payee_name'],
];

it('[BR-ID-33] 盲索引 = HMAC-SHA256(盲索引密钥, utf8(context) ‖ 0x00 ‖ utf8(value))，64 位小写十六进制', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1], 1);
  const crypto = await openFieldCrypto(known.doc, kms);
  const actual = CASES.map(([value, context]) => crypto.blindIndex(value, context));
  expect({
    actual,
    allLowerHex64: actual.every((index) => /^[0-9a-f]{64}$/.test(index)),
  }).toEqual({
    actual: CASES.map(([value, context]) => referenceBlindIndex(known.blindKey, value, context)),
    allLowerHex64: true,
  });
});

it('[BR-ID-33] 去重与查询：同一个值、同一个 context，重复计算、换一个实例、重新打开 keyring，盲索引都相同', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1, 2], 2);
  const first = await openFieldCrypto(known.doc, kms);
  const second = await openFieldCrypto(structuredClone(known.doc), new FakeKms());
  const expected = referenceBlindIndex(known.blindKey, SAMPLES.phone, 'users.phone');
  expect([
    first.blindIndex(SAMPLES.phone, 'users.phone'),
    first.blindIndex(SAMPLES.phone, 'users.phone'),
    second.blindIndex(SAMPLES.phone, 'users.phone'),
  ]).toEqual([expected, expected, expected]);
});

it('[BR-ID-33] 不同的值盲索引不同；同一个值换 context 盲索引不同；context 与值的分界不能挪动', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1], 1);
  const crypto = await openFieldCrypto(known.doc, kms);
  const pairs: readonly (readonly [value: string, context: string])[] = [
    [SAMPLES.phone, 'users.phone'],
    ['13800000001', 'users.phone'],
    [SAMPLES.phone, 'payout_accounts.alipay'],
    [SAMPLES.phone, 'users.phon'],
    // Same concatenation of context and value, different boundary.
    ['e13800000000', 'users.phon'],
    ['bc', 'a'],
    ['c', 'ab'],
    // Case and width are the caller's to normalise: different strings, different indexes.
    [SAMPLES.idNo.toLowerCase(), 'realname.id_no'],
    [SAMPLES.idNo, 'realname.id_no'],
    [`${SAMPLES.phone} `, 'users.phone'],
  ];
  const indexes = pairs.map(([value, context]) => crypto.blindIndex(value, context));
  expect({
    distinct: new Set(indexes).size,
    indexes,
  }).toEqual({
    distinct: pairs.length,
    indexes: pairs.map(([value, context]) => referenceBlindIndex(known.blindKey, value, context)),
  });
});

it('[BR-ID-33] 数据密钥轮换不改变盲索引：轮换后按盲索引去重与查询照常成立', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1], 1);
  const before = await openFieldCrypto(known.doc, kms);
  const rotatedTwice = await rotateDataKey(await rotateDataKey(known.doc, kms), kms);
  const after = await openFieldCrypto(rotatedTwice, kms);
  expect({
    dataKeyVersion: [before.currentKeyVersion, after.currentKeyVersion],
    before: CASES.map(([value, context]) => before.blindIndex(value, context)),
    after: CASES.map(([value, context]) => after.blindIndex(value, context)),
  }).toEqual({
    dataKeyVersion: [1, 3],
    before: CASES.map(([value, context]) => referenceBlindIndex(known.blindKey, value, context)),
    after: CASES.map(([value, context]) => referenceBlindIndex(known.blindKey, value, context)),
  });
});

it('[BR-ID-33] 盲索引只由盲索引密钥决定：数据密钥相同而盲索引密钥不同则索引不同，数据密钥不同而盲索引密钥相同则索引相同', async () => {
  const kms = new FakeKms();
  const base = knownKeyring(kms, [1], 1);
  const otherBlindKey = knownKeyring(kms, [1], 1, BLIND_KEY_LABEL + 1);
  const otherDataKey = knownKeyring(kms, [2], 2);
  const [a, b, c] = await Promise.all(
    [base, otherBlindKey, otherDataKey].map((known) => openFieldCrypto(known.doc, kms)),
  );
  expect({
    base: a?.blindIndex(SAMPLES.phone, 'users.phone'),
    otherBlindKey: b?.blindIndex(SAMPLES.phone, 'users.phone'),
    otherDataKey: c?.blindIndex(SAMPLES.phone, 'users.phone'),
  }).toEqual({
    base: referenceBlindIndex(testKey(BLIND_KEY_LABEL), SAMPLES.phone, 'users.phone'),
    otherBlindKey: referenceBlindIndex(testKey(BLIND_KEY_LABEL + 1), SAMPLES.phone, 'users.phone'),
    otherDataKey: referenceBlindIndex(testKey(BLIND_KEY_LABEL), SAMPLES.phone, 'users.phone'),
  });
});

it('[BR-ID-33] 盲索引与加密的随机性无关：同一个值两次加密密文不同，盲索引相同，且盲索引不出现在密文里', async () => {
  const kms = new FakeKms();
  const crypto = await openFieldCrypto(knownKeyring(kms, [1], 1).doc, kms);
  const first = crypto.encrypt(SAMPLES.bankCard, 'payout_accounts.bank_card');
  const second = crypto.encrypt(SAMPLES.bankCard, 'payout_accounts.bank_card');
  const index = crypto.blindIndex(SAMPLES.bankCard, 'payout_accounts.bank_card');
  expect({
    ciphertextsDiffer: first !== second,
    sameIndexAgain: crypto.blindIndex(SAMPLES.bankCard, 'payout_accounts.bank_card') === index,
    indexLooksLikeHmac: /^[0-9a-f]{64}$/.test(index),
    indexContainsValue: index.includes(SAMPLES.bankCard),
  }).toEqual({
    ciphertextsDiffer: true,
    sameIndexAgain: true,
    indexLooksLikeHmac: true,
    indexContainsValue: false,
  });
});

it('[BR-ID-33] 要索引的值必须是非空、良构的字符串，context 必须合法：否则抛 invalid_plaintext / invalid_context，不产出索引', async () => {
  const kms = new FakeKms();
  const crypto = await openFieldCrypto(knownKeyring(kms, [1], 1).doc, kms);
  const badValues: Record<string, unknown> = {
    empty: '',
    loneSurrogate: '\udfff',
    number: 13800000000,
    nullValue: null,
    undefinedValue: undefined,
  };
  const badContexts: Record<string, unknown> = {
    empty: '',
    tooLong: 'c'.repeat(201),
    space: 'users phone',
    nul: 'users\u0000phone',
    nonAscii: '用户.手机',
    undefinedValue: undefined,
  };
  expect({
    values: Object.fromEntries(
      Object.entries(badValues).map(([name, value]) => [
        name,
        outcomeOf(() => crypto.blindIndex(value as string, 'users.phone')),
      ]),
    ),
    contexts: Object.fromEntries(
      Object.entries(badContexts).map(([name, context]) => [
        name,
        outcomeOf(() => crypto.blindIndex(SAMPLES.phone, context as string)),
      ]),
    ),
    longestContext: outcomeOf(() => crypto.blindIndex(SAMPLES.phone, 'c'.repeat(200))),
  }).toEqual({
    values: Object.fromEntries(Object.keys(badValues).map((name) => [name, 'invalid_plaintext'])),
    contexts: Object.fromEntries(Object.keys(badContexts).map((name) => [name, 'invalid_context'])),
    longestContext: 'returned',
  });
});
