// Shared helpers of the platform/crypto rule tests (规划/08 BR-ID-33; 规划/02 §12.3).
// Nothing here calls the code under test: the reference functions use node:crypto directly, so
// expected values never come from the implementation (规划/11 §2.3 step 4).
// Key bytes are derived by code from small numbers; no key literal appears in the rule tests.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import {
  FieldCryptoError,
  type FieldCryptoErrorCode,
  type KeyProvider,
  type WrappedKeyring,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';

export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;

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

/** Every text form in which a logger could print an object or an error. */
export function printedForms(value: unknown): string[] {
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
