// Rule tests for 规划/08 BR-ID-33「个人敏感信息加密与脱敏」, the encryption clauses: 身份证号、
// 收款账号、手机号必须以 AES-256-GCM 字段级加密存储，密文带 key_version。The persisted format
// (`v1.<key_version>.<base64url(IV ‖ ciphertext ‖ tag)>`, AAD = context) is the one written in
// the header of apps/api/src/modules/platform/crypto/index.ts; every expected value here is
// computed with node:crypto in kit.ts, never by the code under test.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  type FieldCrypto,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FakeKms,
  IV_BYTES,
  SAMPLES,
  TAG_BYTES,
  b64url,
  flipPayloadBit,
  formatV1,
  knownKeyring,
  outcomeOf,
  parseV1,
  referenceDecrypt,
  referenceEncrypt,
  testBytes,
} from './kit.ts';

const CONTEXTS = {
  phone: 'users.phone',
  idNo: 'realname.id_no',
  alipay: 'payout_accounts.alipay_logon_id',
  bankCard: 'payout_accounts.bank_card_no',
  name: 'realname.name',
  astral: 'payout_accounts.payee_name:0199a1b2-7c3d-7e4f-8a5b-6c7d8e9f0a1b',
} as const;

const FIELDS = Object.keys(SAMPLES) as (keyof typeof SAMPLES)[];

async function open(
  versions: readonly number[],
  current: number,
): Promise<{ crypto: FieldCrypto; dataKey: (version: number) => Buffer }> {
  const kms = new FakeKms();
  const known = knownKeyring(kms, versions, current);
  return { crypto: await openFieldCrypto(known.doc, kms), dataKey: known.dataKey };
}

it('[BR-ID-33] 加密结果是 AES-256-GCM：按 v1 格式用 node:crypto 和 32 字节数据密钥独立解密，得到原文', async () => {
  const { crypto, dataKey } = await open([1], 1);
  const decrypted: Record<string, string> = {};
  const payloadBytes: Record<string, number> = {};
  const expectedBytes: Record<string, number> = {};
  for (const field of FIELDS) {
    const ciphertext = crypto.encrypt(SAMPLES[field], CONTEXTS[field]);
    decrypted[field] = referenceDecrypt(dataKey(1), ciphertext, CONTEXTS[field]);
    payloadBytes[field] = parseV1(ciphertext).payload.length;
    // 12-byte IV, the ciphertext is as long as the UTF-8 plaintext, 16-byte tag.
    expectedBytes[field] = IV_BYTES + Buffer.byteLength(SAMPLES[field], 'utf8') + TAG_BYTES;
  }
  expect({ decrypted, payloadBytes }).toEqual({ decrypted: SAMPLES, payloadBytes: expectedBytes });
});

it('[BR-ID-33] 按 v1 格式用 node:crypto 独立加密的密文，decrypt 解出原文（格式与算法互通）', async () => {
  const { crypto, dataKey } = await open([1, 2], 2);
  const decrypted: Record<string, string> = {};
  for (const field of FIELDS) {
    // Version 1 is not the current one: decrypt picks the key the ciphertext names.
    const ciphertext = referenceEncrypt(dataKey(1), 1, SAMPLES[field], CONTEXTS[field]);
    decrypted[field] = crypto.decrypt(ciphertext, CONTEXTS[field]);
  }
  expect(decrypted).toEqual(SAMPLES);
});

it('[BR-ID-33] 同一明文、同一 context 加密 50 次：IV 两两不同、密文两两不同，每一份都能解回原文', async () => {
  const { crypto } = await open([1], 1);
  const ciphertexts = Array.from({ length: 50 }, () =>
    crypto.encrypt(SAMPLES.phone, CONTEXTS.phone),
  );
  const ivs = ciphertexts.map((c) => parseV1(c).payload.subarray(0, IV_BYTES).toString('hex'));
  expect({
    distinctCiphertexts: new Set(ciphertexts).size,
    distinctIvs: new Set(ivs).size,
    decrypted: [...new Set(ciphertexts.map((c) => crypto.decrypt(c, CONTEXTS.phone)))],
  }).toEqual({ distinctCiphertexts: 50, distinctIvs: 50, decrypted: [SAMPLES.phone] });
});

it('[BR-ID-33] 同一把数据密钥下 IV 不重复、且是随机的：同一份 keyring 先后打开 5 个实例各加密 20 次，100 个 IV 两两不同，96 位里每一位都出现过 0 和 1', async () => {
  const known = knownKeyring(new FakeKms(), [1], 1);
  const ivs: Buffer[] = [];
  for (let instance = 0; instance < 5; instance += 1) {
    // A fresh instance every time, as after a process restart: a per-instance counter or a
    // fixed prefix would repeat here, and a repeated IV under one key breaks AES-GCM.
    const crypto = await openFieldCrypto(structuredClone(known.doc), new FakeKms());
    for (let i = 0; i < 20; i += 1) {
      const text = i % 2 === 0 ? SAMPLES.phone : `139${String(10000000 + instance * 100 + i)}`;
      const ciphertext = crypto.encrypt(text, CONTEXTS.phone);
      ivs.push(Buffer.from(parseV1(ciphertext).payload.subarray(0, IV_BYTES)));
    }
  }
  const stuckBits: number[] = [];
  for (let bit = 0; bit < IV_BYTES * 8; bit += 1) {
    const ones = ivs.filter((iv) => ((iv[bit >> 3] ?? 0) >> (bit & 7)) % 2 === 1).length;
    // For random IVs a bit that never changes in 100 samples has probability 2^-99.
    if (ones === 0 || ones === ivs.length) stuckBits.push(bit);
  }
  expect({
    total: ivs.length,
    distinct: new Set(ivs.map((iv) => iv.toString('hex'))).size,
    stuckBits,
  }).toEqual({ total: 100, distinct: 100, stuckBits: [] });
});

it('[BR-ID-33] 密文里找不到明文：密文文本和解码后的载荷都不含明文字节', async () => {
  const { crypto } = await open([1], 1);
  const found: string[] = [];
  for (const field of FIELDS) {
    const ciphertext = crypto.encrypt(SAMPLES[field], CONTEXTS[field]);
    const plainBytes = Buffer.from(SAMPLES[field], 'utf8');
    if (ciphertext.includes(SAMPLES[field])) found.push(`${field}: text`);
    if (ciphertext.includes(b64url(plainBytes))) found.push(`${field}: base64url`);
    if (parseV1(ciphertext).payload.includes(plainBytes)) found.push(`${field}: payload`);
  }
  expect(found).toEqual([]);
});

it('[BR-ID-33] 密文带 key_version：形如 v1.<key_version>.<payload>，用当前版本加密，keyVersionOf 不解密就能读出版本', async () => {
  const { crypto, dataKey } = await open([1, 2, 7], 7);
  const ciphertext = crypto.encrypt(SAMPLES.idNo, CONTEXTS.idNo);
  // A payload nobody can decrypt: the version is still readable.
  const undecryptable = formatV1(2, testBytes(1, 40));
  expect({
    current: crypto.currentKeyVersion,
    shape: /^v1\.7\.[A-Za-z0-9_-]+$/.test(ciphertext),
    ofNew: crypto.keyVersionOf(ciphertext),
    ofOld: crypto.keyVersionOf(referenceEncrypt(dataKey(1), 1, SAMPLES.idNo, CONTEXTS.idNo)),
    ofUndecryptable: crypto.keyVersionOf(undecryptable),
    decryptUndecryptable: outcomeOf(() => crypto.decrypt(undecryptable, CONTEXTS.idNo)),
  }).toEqual({
    current: 7,
    shape: true,
    ofNew: 7,
    ofOld: 1,
    ofUndecryptable: 2,
    decryptUndecryptable: 'decrypt_failed',
  });
});

it('[BR-ID-33] 篡改密文任何一处都解不开：改 IV、密文体、tag 的任一位，截短或接长，一律抛 decrypt_failed，不返回文本', async () => {
  const { crypto } = await open([1], 1);
  const ciphertext = crypto.encrypt(SAMPLES.bankCard, CONTEXTS.bankCard);
  const { version, payload } = parseV1(ciphertext);
  const lastBit = payload.length * 8 - 1;
  const tampered: Record<string, string> = {
    ivFirstBit: flipPayloadBit(ciphertext, 0),
    ivLastBit: flipPayloadBit(ciphertext, IV_BYTES * 8 - 1),
    bodyFirstBit: flipPayloadBit(ciphertext, IV_BYTES * 8),
    bodyLastBit: flipPayloadBit(ciphertext, (payload.length - TAG_BYTES) * 8 - 1),
    tagFirstBit: flipPayloadBit(ciphertext, (payload.length - TAG_BYTES) * 8),
    tagLastBit: flipPayloadBit(ciphertext, lastBit),
    truncatedByOneByte: formatV1(version, payload.subarray(0, payload.length - 1)),
    extendedByOneByte: formatV1(version, Buffer.concat([payload, Buffer.from([0])])),
    bodyDropped: formatV1(
      version,
      Buffer.concat([payload.subarray(0, IV_BYTES + 1), payload.subarray(-TAG_BYTES)]),
    ),
  };
  const outcomes: Record<string, string> = {};
  for (const [name, text] of Object.entries(tampered)) {
    outcomes[name] = outcomeOf(() => crypto.decrypt(text, CONTEXTS.bankCard));
  }
  expect({
    untouched: crypto.decrypt(ciphertext, CONTEXTS.bankCard),
    outcomes,
  }).toEqual({
    untouched: SAMPLES.bankCard,
    outcomes: Object.fromEntries(Object.keys(tampered).map((name) => [name, 'decrypt_failed'])),
  });
});

it('[BR-ID-33] 密文只在加密时的 context 下能解：换成别的字段、别的行、大小写不同的 context 都抛 decrypt_failed', async () => {
  const { crypto } = await open([1], 1);
  const ciphertext = crypto.encrypt(SAMPLES.alipay, CONTEXTS.alipay);
  const others = [
    CONTEXTS.bankCard,
    `${CONTEXTS.alipay}:0199a1b2-7c3d-7e4f-8a5b-6c7d8e9f0a1b`,
    CONTEXTS.alipay.toUpperCase(),
    CONTEXTS.alipay.slice(0, -1),
  ];
  expect({
    same: crypto.decrypt(ciphertext, CONTEXTS.alipay),
    others: others.map((context) => outcomeOf(() => crypto.decrypt(ciphertext, context))),
  }).toEqual({ same: SAMPLES.alipay, others: others.map(() => 'decrypt_failed') });
});

it('[BR-ID-33] 改 key_version 前缀换不来别的密钥解密：指到 keyring 里另一版本抛 decrypt_failed，指到没有的版本抛 unknown_key_version', async () => {
  const { crypto } = await open([1, 2], 2);
  const ciphertext = crypto.encrypt(SAMPLES.phone, CONTEXTS.phone);
  const { payload } = parseV1(ciphertext);
  expect({
    asWritten: crypto.decrypt(ciphertext, CONTEXTS.phone),
    otherVersion: outcomeOf(() => crypto.decrypt(formatV1(1, payload), CONTEXTS.phone)),
    missingVersion: outcomeOf(() => crypto.decrypt(formatV1(9, payload), CONTEXTS.phone)),
    missingVersionRead: crypto.keyVersionOf(formatV1(9, payload)),
    missingVersionReencrypt: outcomeOf(() =>
      crypto.reencrypt(formatV1(9, payload), CONTEXTS.phone),
    ),
  }).toEqual({
    asWritten: SAMPLES.phone,
    otherVersion: 'decrypt_failed',
    missingVersion: 'unknown_key_version',
    missingVersionRead: 9,
    missingVersionReencrypt: 'unknown_key_version',
  });
});

it('[BR-ID-33] 不是 v1.<key_version>.<payload> 的文本一律抛 malformed_ciphertext：decrypt、keyVersionOf、needsReencrypt、reencrypt 都不把它当密文', async () => {
  const { crypto } = await open([1], 1);
  const good = crypto.encrypt(SAMPLES.phone, CONTEXTS.phone);
  const payload = b64url(parseV1(good).payload);
  const malformed: Record<string, string> = {
    empty: '',
    plaintextItself: SAMPLES.phone,
    otherFormat: `v2.1.${payload}`,
    upperCaseFormat: `V1.1.${payload}`,
    noVersion: `v1..${payload}`,
    versionZero: `v1.0.${payload}`,
    versionLeadingZero: `v1.01.${payload}`,
    versionSigned: `v1.+1.${payload}`,
    versionNegative: `v1.-1.${payload}`,
    versionTooLarge: `v1.2147483648.${payload}`,
    versionNotANumber: `v1.one.${payload}`,
    extraPart: `v1.1.${payload}.${payload}`,
    noPayload: 'v1.1.',
    onlyTwoParts: `v1.${payload}`,
    payloadNotBase64url: `v1.1.${payload.slice(0, -1)}!`,
    payloadPadded: `v1.1.${payload}=`,
    leadingSpace: ` ${good}`,
    trailingNewline: `${good}\n`,
    // Shorter than IV + one byte + tag: cannot be a ciphertext of a non-empty plaintext.
    payloadTooShort: formatV1(1, testBytes(2, IV_BYTES + TAG_BYTES)),
  };
  const expected = Object.fromEntries(
    Object.keys(malformed).map((name) => [name, 'malformed_ciphertext']),
  );
  const run = (call: (text: string) => unknown): Record<string, string> =>
    Object.fromEntries(
      Object.entries(malformed).map(([name, text]) => [name, outcomeOf(() => call(text))]),
    );
  expect({
    decrypt: run((text) => crypto.decrypt(text, CONTEXTS.phone)),
    keyVersionOf: run((text) => crypto.keyVersionOf(text)),
    needsReencrypt: run((text) => crypto.needsReencrypt(text)),
    reencrypt: run((text) => crypto.reencrypt(text, CONTEXTS.phone)),
    notAString: outcomeOf(() => crypto.decrypt(12345 as unknown as string, CONTEXTS.phone)),
  }).toEqual({
    decrypt: expected,
    keyVersionOf: expected,
    needsReencrypt: expected,
    reencrypt: expected,
    notAString: 'malformed_ciphertext',
  });
});

it('[BR-ID-33] 明文必须是非空、良构的字符串：空串、孤立代理项、非字符串一律抛 invalid_plaintext，不产出密文', async () => {
  const { crypto } = await open([1], 1);
  const bad: Record<string, unknown> = {
    empty: '',
    loneHighSurrogate: '\ud83d',
    loneLowSurrogate: `138${'\udc00'}0000`,
    number: 13800000000,
    nullValue: null,
    undefinedValue: undefined,
    bytes: Buffer.from(SAMPLES.phone),
  };
  const outcomes = Object.fromEntries(
    Object.entries(bad).map(([name, value]) => [
      name,
      outcomeOf(() => crypto.encrypt(value as string, CONTEXTS.phone)),
    ]),
  );
  expect(outcomes).toEqual(
    Object.fromEntries(Object.keys(bad).map((name) => [name, 'invalid_plaintext'])),
  );
});

it('[BR-ID-33] context 必须是 1 到 200 个可见 ASCII 字符：为空、超长、带空白 / 控制字符 / 非 ASCII、非字符串一律抛 invalid_context', async () => {
  const { crypto } = await open([1], 1);
  const longest = 'c'.repeat(200);
  const good = crypto.encrypt(SAMPLES.phone, longest);
  const bad: Record<string, unknown> = {
    empty: '',
    tooLong: 'c'.repeat(201),
    space: 'users phone',
    tab: 'users\tphone',
    newline: 'users.phone\n',
    nul: 'users\u0000phone',
    del: 'users\u007fphone',
    nonAscii: '用户.手机',
    nullValue: null,
    undefinedValue: undefined,
  };
  const expected = Object.fromEntries(Object.keys(bad).map((name) => [name, 'invalid_context']));
  const run = (call: (context: string) => unknown): Record<string, string> =>
    Object.fromEntries(
      Object.entries(bad).map(([name, context]) => [
        name,
        outcomeOf(() => call(context as string)),
      ]),
    );
  expect({
    longestAllowed: crypto.decrypt(good, longest),
    encrypt: run((context) => crypto.encrypt(SAMPLES.phone, context)),
    decrypt: run((context) => crypto.decrypt(good, context)),
    reencrypt: run((context) => crypto.reencrypt(good, context)),
  }).toEqual({
    longestAllowed: SAMPLES.phone,
    encrypt: expected,
    decrypt: expected,
    reencrypt: expected,
  });
});
