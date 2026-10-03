// Shared helpers of the platform/crypto rule tests (规划/08 BR-ID-33; 规划/02 §12.3).
// Nothing here calls the code under test: the reference functions use node:crypto directly, so
// expected values never come from the implementation (规划/11 §2.3 step 4).
// Key bytes are derived by code from small numbers; no key literal appears in the rule tests.
// Leaks are checked exactly wherever the contract allows it (the error's message, stack and
// properties; the own properties of the objects; everything a process prints), and by searching
// printed forms for secrets only as a second net.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { inspect, types } from 'node:util';
import {
  FieldCryptoError,
  type FieldCryptoErrorCode,
  type KeyProvider,
  type WrappedKeyring,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';

export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;

/**
 * The fixed message of every error code, copied from the contract (not imported, so that the
 * contract cannot change under the tests).
 */
export const MESSAGES: Readonly<Record<FieldCryptoErrorCode, string>> = {
  invalid_key: 'key has the wrong length',
  invalid_keyring: 'keyring or wrapped key is malformed or belongs to another master key',
  invalid_context: 'context must be 1 to 200 printable ASCII characters',
  invalid_plaintext: 'value must be a non-empty well-formed string',
  malformed_ciphertext: 'text is not a v1 ciphertext',
  unknown_key_version: 'the keyring does not hold this key version',
  decrypt_failed: 'decryption failed',
  key_provider_failed: 'the key provider failed',
};

const ERROR_KEYS = new Set<PropertyKey>(['stack', 'message', 'name', 'code']);

/** One V8 stack frame: `    at [async ][function (]location[)]`, the location a file, node or native. */
const FRAME =
  /^ {4}at (?:async )?(?:.+ \()?(?:file:\/\/\S+:\d+:\d+|node:\S+:\d+:\d+|\/\S+:\d+:\d+|<anonymous>|native|index \d+)\)?$/;

/**
 * Why `error` is not exactly a contract error of `code`: an empty list when it is a
 * FieldCryptoError named 'FieldCryptoError' with that code, exactly the fixed message, a stack
 * that is that message followed by plain `at …` frames, and no property besides stack, message,
 * name and code (no `cause`). Such an error cannot carry a value into a log.
 */
export function errorProblems(error: unknown, code: FieldCryptoErrorCode): string[] {
  if (!(error instanceof FieldCryptoError)) return [`not a FieldCryptoError: ${String(error)}`];
  const problems: string[] = [];
  if (error.name !== 'FieldCryptoError') problems.push('name');
  if (error.code !== code) problems.push(`code ${String(error.code)}`);
  if (error.message !== MESSAGES[code]) problems.push('message');
  const [first, ...frames] = (error.stack ?? '').split('\n');
  if (first !== `FieldCryptoError: ${MESSAGES[code]}`) problems.push('stack head');
  if (frames.length === 0 || frames.some((line) => !FRAME.test(line))) {
    problems.push('stack frames');
  }
  const extra = Reflect.ownKeys(error).filter((key) => !ERROR_KEYS.has(key));
  if (extra.length > 0) problems.push(`own properties ${extra.map(String).join(',')}`);
  if ('cause' in error) problems.push('cause');
  return problems;
}

/** Own properties a function may have: anything else could hold data. */
const FUNCTION_KEYS = new Set<PropertyKey>(['length', 'name', 'prototype']);

const FIELD_CRYPTO_KEYS = new Set<PropertyKey>([
  'currentKeyVersion',
  'encrypt',
  'decrypt',
  'keyVersionOf',
  'needsReencrypt',
  'reencrypt',
  'blindIndex',
]);

/**
 * Why the object handed out is not exactly the contract's shape: a LocalKeyProvider has only the
 * own property `keyId` (with the given value), a FieldCrypto only `currentKeyVersion` and its six
 * methods; neither is a Proxy and no method carries own data. An empty list means a logger that
 * prints the object (JSON or util.inspect, hidden properties included) sees no key and no value.
 */
export function shapeProblems(
  value: object,
  kind: { readonly provider: string } | { readonly fieldCrypto: number },
): string[] {
  const problems: string[] = [];
  if (types.isProxy(value)) problems.push('proxy');
  const own = Reflect.ownKeys(value);
  if ('provider' in kind) {
    if (own.length !== 1 || own[0] !== 'keyId') problems.push(`own ${own.map(String).join(',')}`);
    if ((value as { keyId?: unknown }).keyId !== kind.provider) problems.push('keyId');
    return problems;
  }
  const extra = own.filter((key) => !FIELD_CRYPTO_KEYS.has(key));
  if (extra.length > 0) problems.push(`own ${extra.map(String).join(',')}`);
  const record = value as Record<PropertyKey, unknown>;
  if (record['currentKeyVersion'] !== kind.fieldCrypto) problems.push('currentKeyVersion');
  for (const key of own) {
    if (key === 'currentKeyVersion' || !FIELD_CRYPTO_KEYS.has(key)) continue;
    const method = record[key];
    if (typeof method !== 'function') {
      problems.push(`${String(key)} is not a function`);
    } else if (
      types.isProxy(method) ||
      Reflect.ownKeys(method).some((k) => !FUNCTION_KEYS.has(k))
    ) {
      problems.push(`${String(key)} carries data`);
    }
  }
  return problems;
}

/** Bits (0 = lowest bit of the first byte) that have the same value in every sample. */
export function stuckBits(samples: readonly Uint8Array[], bits: number): number[] {
  const stuck: number[] = [];
  for (let bit = 0; bit < bits; bit += 1) {
    const ones = samples.filter((s) => ((s[bit >> 3] ?? 0) >> (bit & 7)) % 2 === 1).length;
    if (ones === 0 || ones === samples.length) stuck.push(bit);
  }
  return stuck;
}

/** Synthetic sample values (no real person): the three kinds of field BR-ID-33 names, plus text
 * with multi-byte characters (3-byte CJK and a 4-byte code point written as an escape). */
export const SAMPLES = {
  phone: '13800000000',
  idNo: '11010519491231002X',
  alipay: 'rule-test@example.com',
  bankCard: '6200000000000000000',
  name: '测试三',
  astral: '收款人\u{1F600}（测试）',
} as const;

/** Deterministic 32 test bytes for a small label number. */
export function testKey(label: number): Buffer {
  return createHash('sha256')
    .update(Buffer.from([0xc0, 0x11, label & 0xff, (label >> 8) & 0xff]))
    .digest();
}

/** Deterministic test bytes of any length. */
export function testBytes(label: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let filled = 0;
  for (let block = 0; filled < length; block += 1) {
    const chunk = createHash('sha256')
      .update(Buffer.from([0xb1, label & 0xff, block & 0xff]))
      .digest();
    filled += chunk.copy(out, filled);
  }
  return out;
}

function pad(keyId: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let filled = 0;
  for (let block = 0; filled < length; block += 1) {
    const chunk = createHash('sha256')
      .update(`${keyId}#${String(block)}`)
      .digest();
    filled += chunk.copy(out, filled);
  }
  return out;
}

const FAKE_PREFIX = 'fk1:';

/** How the in-test KMS "wraps": XOR with a pad derived from the key id, then hex. Not security,
 * only a transformation after which no plain encoding of the key is left in the text. */
export function fakeWrap(plainKey: Uint8Array, keyId: string): string {
  const plain = Buffer.from(plainKey);
  const mask = pad(keyId, plain.length);
  return FAKE_PREFIX + Buffer.from(plain.map((byte, i) => byte ^ (mask[i] ?? 0))).toString('hex');
}

export function fakeUnwrap(wrappedKey: string, keyId: string): Buffer {
  if (!wrappedKey.startsWith(FAKE_PREFIX) || !/^[0-9a-f]*$/.test(wrappedKey.slice(4))) {
    throw new Error('fake kms: not a text wrapped by this fake');
  }
  const masked = Buffer.from(wrappedKey.slice(FAKE_PREFIX.length), 'hex');
  const mask = pad(keyId, masked.length);
  return Buffer.from(masked.map((byte, i) => byte ^ (mask[i] ?? 0)));
}

/** In-test stand-in for KMS: a KeyProvider that records what it is asked to do. */
export class FakeKms implements KeyProvider {
  readonly keyId: string;
  /** Plain keys handed to wrapKey, in call order. */
  readonly wrappedPlainKeys: Buffer[] = [];
  /** Wrapped texts handed to unwrapKey, in call order. */
  readonly unwrapRequests: string[] = [];
  /** unwrapKey rejects for exactly this wrapped text. */
  failUnwrapOf: string | null = null;

  constructor(keyId: string = 'fake-kms/master-a') {
    this.keyId = keyId;
  }

  wrapKey(plainKey: Uint8Array): Promise<string> {
    const plain = Buffer.from(plainKey);
    this.wrappedPlainKeys.push(plain);
    return Promise.resolve(fakeWrap(plain, this.keyId));
  }

  unwrapKey(wrappedKey: string): Promise<Uint8Array> {
    this.unwrapRequests.push(wrappedKey);
    if (wrappedKey === this.failUnwrapOf) {
      return Promise.reject(new Error('fake kms: unwrap refused'));
    }
    try {
      return Promise.resolve(fakeUnwrap(wrappedKey, this.keyId));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * A KeyProvider standing for a KMS that fails, with errors that quote a secret (a KMS error may
 * echo the request): `how` says which call fails and whether it rejects or throws synchronously;
 * `call` which call of that kind fails (1 = the first; earlier ones go to the wrapped FakeKms);
 * `kind` whether the error is a plain Error or a FieldCryptoError coded key_provider_failed, both
 * with the secret in the message and in a property.
 */
export class FailingKms implements KeyProvider {
  readonly keyId: string;
  readonly #inner: FakeKms;
  readonly #how: 'reject-wrap' | 'throw-wrap' | 'reject-unwrap' | 'throw-unwrap';
  readonly #secret: string;
  readonly #call: number;
  readonly #kind: 'error' | 'field-crypto-error';
  #wraps = 0;
  #unwraps = 0;

  constructor(
    inner: FakeKms,
    how: 'reject-wrap' | 'throw-wrap' | 'reject-unwrap' | 'throw-unwrap',
    secret: string,
    options: { readonly call?: number; readonly kind?: 'error' | 'field-crypto-error' } = {},
  ) {
    this.keyId = inner.keyId;
    this.#inner = inner;
    this.#how = how;
    this.#secret = secret;
    this.#call = options.call ?? 1;
    this.#kind = options.kind ?? 'error';
  }

  #failure(): Error {
    const message = `kms refused the request for ${this.#secret}`;
    const error =
      this.#kind === 'error'
        ? new Error(message)
        : new FieldCryptoError('key_provider_failed', message);
    return Object.assign(error, { request: this.#secret });
  }

  wrapKey(plainKey: Uint8Array): Promise<string> {
    this.#wraps += 1;
    if (this.#wraps === this.#call) {
      if (this.#how === 'throw-wrap') throw this.#failure();
      if (this.#how === 'reject-wrap') return Promise.reject(this.#failure());
    }
    return this.#inner.wrapKey(plainKey);
  }

  unwrapKey(wrappedKey: string): Promise<Uint8Array> {
    this.#unwraps += 1;
    if (this.#unwraps === this.#call) {
      if (this.#how === 'throw-unwrap') throw this.#failure();
      if (this.#how === 'reject-unwrap') return Promise.reject(this.#failure());
    }
    return this.#inner.unwrapKey(wrappedKey);
  }
}

/** Label of the blind-index key used by `knownKeyring`. */
export const BLIND_KEY_LABEL = 200;

export interface KnownKeyring {
  readonly doc: WrappedKeyring;
  /** Plain data key of a version: testKey(version). */
  dataKey(version: number): Buffer;
  readonly blindKey: Buffer;
}

/**
 * A keyring document whose plain keys the test knows: data key of version v is testKey(v), the
 * blind-index key is testKey(blindLabel). Built with fakeWrap directly, so the FakeKms call log
 * stays empty until the code under test uses the provider.
 */
export function knownKeyring(
  kms: FakeKms,
  versions: readonly number[],
  current: number,
  blindLabel: number = BLIND_KEY_LABEL,
): KnownKeyring {
  const doc: WrappedKeyring = {
    key_id: kms.keyId,
    current_version: current,
    data_keys: versions.map((version) => ({
      version,
      wrapped: fakeWrap(testKey(version), kms.keyId),
    })),
    blind_index_key: fakeWrap(testKey(blindLabel), kms.keyId),
  };
  return { doc, dataKey: (version) => testKey(version), blindKey: testKey(blindLabel) };
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

const V1 = /^v1\.([1-9][0-9]*)\.([A-Za-z0-9_-]+)$/;

export interface ParsedV1 {
  readonly version: number;
  /** IV ‖ ciphertext ‖ tag. */
  readonly payload: Buffer;
}

/** Splits `v1.<key_version>.<payload>`; throws a plain Error when the text has another shape. */
export function parseV1(ciphertext: string): ParsedV1 {
  const match = V1.exec(ciphertext);
  if (match === null) throw new Error('reference: not a v1 ciphertext');
  return { version: Number(match[1]), payload: Buffer.from(match[2] ?? '', 'base64url') };
}

export function formatV1(version: number | string, payload: Uint8Array): string {
  return `v1.${String(version)}.${b64url(payload)}`;
}

/** Reference encryption in the v1 format with node:crypto. */
export function referenceEncrypt(
  key: Uint8Array,
  version: number,
  plaintext: string,
  context: string,
  iv: Uint8Array = randomBytes(IV_BYTES),
): string {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return formatV1(version, Buffer.concat([iv, body, cipher.getAuthTag()]));
}

/** Reference decryption of the v1 format with node:crypto; throws when authentication fails. */
export function referenceDecrypt(key: Uint8Array, ciphertext: string, context: string): string {
  const { payload } = parseV1(ciphertext);
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const body = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

const LK1 = /^lk1\.([A-Za-z0-9_-]+)$/;

/** IV ‖ ciphertext ‖ tag of a `lk1.<payload>` wrapped key; throws when the text has another shape. */
export function parseLk1(wrapped: string): Buffer {
  const match = LK1.exec(wrapped);
  if (match === null) throw new Error('reference: not a lk1 wrapped key');
  return Buffer.from(match[1] ?? '', 'base64url');
}

/** The IV of a `lk1.<payload>` wrapped key. */
export function ivOfLk1(wrapped: string): Buffer {
  return Buffer.from(parseLk1(wrapped).subarray(0, IV_BYTES));
}

/** Reference key wrapping of LocalKeyProvider: AES-256-GCM under the master key, AAD = keyId. */
export function referenceWrap(
  masterKey: Uint8Array,
  keyId: string,
  plainKey: Uint8Array,
  iv: Uint8Array = randomBytes(IV_BYTES),
): string {
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(keyId, 'utf8'));
  const body = Buffer.concat([cipher.update(plainKey), cipher.final()]);
  return `lk1.${b64url(Buffer.concat([iv, body, cipher.getAuthTag()]))}`;
}

/** Reference unwrapping of a `lk1.<payload>` text; throws when it does not authenticate. */
export function referenceUnwrap(masterKey: Uint8Array, keyId: string, wrapped: string): Buffer {
  const payload = parseLk1(wrapped);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, payload.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(keyId, 'utf8'));
  decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(payload.subarray(IV_BYTES, payload.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

/** Reference blind index: HMAC-SHA256(key, utf8(context) ‖ 0x00 ‖ utf8(value)), lowercase hex. */
export function referenceBlindIndex(key: Uint8Array, value: string, context: string): string {
  return createHmac('sha256', key)
    .update(Buffer.from(context, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(value, 'utf8'))
    .digest('hex');
}

/** The ciphertext with one bit of its payload flipped (re-encoded canonically). */
export function flipPayloadBit(ciphertext: string, bitIndex: number): string {
  const { version, payload } = parseV1(ciphertext);
  const altered = Buffer.from(payload);
  const bit = bitIndex % (altered.length * 8);
  const at = bit >> 3;
  altered[at] = (altered[at] ?? 0) ^ (1 << (bit & 7));
  return formatV1(version, altered);
}

/**
 * What a call did, as a short string: the FieldCryptoError code, `returned` when it did not
 * throw, or the text of any other error. Lets one assertion list every input at once.
 */
export function outcomeOf(run: () => unknown): FieldCryptoErrorCode | 'returned' | string {
  try {
    run();
  } catch (error) {
    if (error instanceof FieldCryptoError) return error.code;
    return `other error: ${String(error)}`;
  }
  return 'returned';
}

/** Same for a promise: the FieldCryptoError code, `resolved`, or the text of any other error. */
export async function rejectionOf(
  run: () => Promise<unknown>,
): Promise<FieldCryptoErrorCode | 'resolved' | string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof FieldCryptoError) return error.code;
    return `other error: ${String(error)}`;
  }
  return 'resolved';
}

/** The error a call throws; fails the test when it returns instead. */
export function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it returned');
}

/**
 * Every text form in which a logger could print an object or an error. Text that was already
 * printed (a captured output) is searched as it is: serialising it again would turn its line
 * breaks into `\n` escapes and hide a multi-line leak.
 */
export function printedForms(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  const forms = [inspect(value, { depth: null, showHidden: true, maxArrayLength: null })];
  try {
    forms.push(JSON.stringify(value) ?? '');
  } catch {
    // Not serialisable (circular, bigint): nothing is printed through JSON.
  }
  if (value instanceof Error) forms.push(String(value), value.message, value.stack ?? '');
  return forms;
}

/** The encodings of `bytes` that would reveal them in printed output (whitespace removed). */
export function encodingsOf(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  return [
    buffer.toString('hex'),
    buffer.toString('base64'),
    buffer.toString('base64url'),
    // Number lists: JSON of a Buffer, util.inspect of a Uint8Array.
    Array.from(buffer).join(','),
  ];
}

/**
 * Each named value as text and as its UTF-8 bytes: kept bytes print as hex (inspect of a
 * Buffer), as a number array (JSON, inspect of a Uint8Array) or as base64, never as the text
 * itself; leaksIn checks every encoding of a byte secret.
 */
export function withBytes(
  values: Readonly<Record<string, string>>,
): Record<string, string | Uint8Array> {
  const secrets: Record<string, string | Uint8Array> = { ...values };
  for (const [name, value] of Object.entries(values)) {
    secrets[`${name} (utf-8)`] = Buffer.from(value, 'utf8');
  }
  return secrets;
}

/**
 * The secrets (strings as they are, bytes in every encoding of `encodingsOf`) that show up in
 * the printed forms of `value`, matched case-insensitively with all whitespace removed. An empty
 * list means nothing leaked.
 */
export function leaksIn(
  value: unknown,
  secrets: Readonly<Record<string, string | Uint8Array>>,
): string[] {
  const printed = printedForms(value).map((form) => form.replace(/\s+/g, '').toLowerCase());
  const found: string[] = [];
  for (const [name, secret] of Object.entries(secrets)) {
    const needles = typeof secret === 'string' ? [secret] : encodingsOf(secret);
    for (const needle of needles) {
      const flat = needle.replace(/\s+/g, '').toLowerCase();
      if (flat !== '' && printed.some((form) => form.includes(flat))) found.push(name);
    }
  }
  return [...new Set(found)];
}
