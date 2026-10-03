// Field encryption and blind index for personal data (规划/08 BR-ID-33; 规划/02 §12.3, §12.6;
// ADR-0001 §2 鉴权与密钥). The rule tests in
// test/spec/platform/crypto/** and test/properties/platform/** import this file by path; the
// names, signatures and the formats described here are the contract.
//
// Envelope encryption. Fields are encrypted with data keys (AES-256-GCM, 32 bytes). Data keys
// are stored only wrapped by a master key that never leaves its `KeyProvider`: KMS in the
// cloud (a later task), `LocalKeyProvider` in local / test. The stored document is a
// `WrappedKeyring`; `openFieldCrypto` unwraps it once at startup and returns a `FieldCrypto`
// whose methods are synchronous.
//
// Ciphertext format, persisted in `*_cipher` columns (a string, so it also fits into JSON):
//   v1.<key_version>.<payload>
//   - `v1`: this format — AES-256-GCM, 12-byte random IV, 16-byte tag;
//   - <key_version>: decimal, 1..2147483647, no sign, no leading zero;
//   - <payload>: base64url (alphabet A-Z a-z 0-9 - _, no padding) of IV ‖ ciphertext ‖ tag; the
//     ciphertext is as long as the UTF-8 plaintext, so a payload of fewer than 12 + 1 + 16 bytes
//     is malformed;
//   - additional authenticated data = the UTF-8 bytes of `context`;
//   - nothing before or after: no whitespace, no other prefix.
// Blind index format, persisted in `*_hmac` columns: lowercase hex (64 characters) of
//   HMAC-SHA256(blind_index_key, utf8(context) ‖ 0x00 ‖ utf8(value)).
// The blind-index key is separate from the data keys and is not rotated with them.
// Wrapped-key format of `LocalKeyProvider` (what its `wrapKey` returns; it ends up in the stored
// keyring):
//   lk1.<payload>
//   - `lk1`: AES-256-GCM under the provider's 32-byte master key, 12-byte IV, 16-byte tag;
//   - <payload>: base64url (no padding) of IV ‖ ciphertext ‖ tag, where the ciphertext is exactly
//     as long as the wrapped key: the key is encrypted as it is, nothing is added to it;
//   - additional authenticated data = the UTF-8 bytes of the provider's `keyId`;
//   - nothing before or after.
//
// Randomness. Random bytes come only from `randomBytes` of `node:crypto`, one call per value:
// every IV (field encryption and key wrapping) is the result of its own `randomBytes(12)`, every
// new data key and blind-index key the result of its own `randomBytes(32)`, used as returned.
// So `encrypt`, `reencrypt` and `LocalKeyProvider.wrapKey` call `randomBytes(12)` exactly once,
// `createWrappedKeyring` calls `randomBytes(32)` exactly twice and `rotateDataKey` exactly once
// (plus whatever the provider's `wrapKey` does), and nothing else calls it. The restart rule
// tests replace `randomBytes` in a new process and compare the IVs and keys with what it returned.
//
// Errors. Every error this module throws or rejects with is a `FieldCryptoError` whose `name` is
// 'FieldCryptoError', whose `code` is one of `FieldCryptoErrorCode` and whose `message` is exactly
// the text of its code in `FIELD_CRYPTO_MESSAGES`. Nothing else is attached (no `cause`, no other
// property, the stack is the plain stack of that message). `LocalKeyProvider.unwrapKey` rejects
// text that is not `lk1.<payload>` (payload shorter than 12 + 1 + 16 bytes included) with
// `invalid_keyring`, and text that does not authenticate (another master key, another `keyId`,
// altered) with `decrypt_failed`; `LocalKeyProvider.wrapKey` rejects anything but a non-empty
// Uint8Array with `invalid_key`. A provider's failure is never passed on: when the provider's
// `wrapKey` or `unwrapKey` throws or rejects (with whatever error, a `FieldCryptoError` included),
// `createWrappedKeyring`, `rotateDataKey` and `openFieldCrypto` reject with `key_provider_failed`
// and keep nothing of the provider's error (a KMS error may quote the request).
//
// What a logger can see. A `LocalKeyProvider` has exactly one own property, `keyId`; a
// `FieldCrypto` has no own properties but `currentKeyVersion` and the six methods; neither is a
// Proxy, and key bytes and plaintexts live only in private class fields (#…) or closures. The
// module prints nothing: no console, no process.stdout / stderr, no warnings.
//
// `context` names what the value is (for example `users.phone`, or `payout_accounts.alipay:<id>`
// when the caller binds a ciphertext to its row): 1..200 printable ASCII characters
// (0x21..0x7e), so no space, no control character, no NUL. A ciphertext only decrypts under the
// context it was encrypted with. Normalising a value before indexing it (phone format, upper-case
// X of an id number, …) is the caller's job: this module hashes exactly the string it is given.
//
// Rules for the implementation:
// - This directory is also compiled by the `test` project: erasable syntax only (no parameter
//   properties, no enum, no namespace, no decorators), `import type` for type-only imports,
//   relative imports with the `.ts` extension, no NestJS, no `process.env`, no logging.
// - The restart rule tests also start plain `node` on this file in new processes (Node's own
//   type stripping, no build step, no bundler): besides the rules above, import nothing but
//   `node:` modules and files of this directory.
// - A new process that has the master key, the stored keyring and the ciphertexts — and nothing
//   else — must decrypt them and compute the same blind indexes, and IVs must not repeat across
//   processes that share a keyring: no state that only lives in memory (no table of wrapped
//   keys, no IV counter).
// - Only `node:crypto` (no new dependency). Random bytes: see «Randomness» above.
// - Error messages are the fixed texts below and never echo an argument (not the plaintext, not
//   the text given as ciphertext, not even a rejected context: a caller that swaps two arguments
//   would otherwise put the value into the logs).
// - Nothing reachable through JSON.stringify or util.inspect (hidden properties included) of a
//   `FieldCrypto` or a `LocalKeyProvider` may reveal key bytes or a plaintext in any encoding:
//   these objects end up in logs (see «What a logger can see»).
// - Key material in test files is generated by code (never a literal): the secret scanner
//   rejects key-looking literals.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export type FieldCryptoErrorCode =
  /** Key bytes of the wrong length (data key and master key: exactly 32; blind-index key: ≥ 32). */
  | 'invalid_key'
  /** The keyring document is malformed, or was wrapped under another master key (`key_id`). */
  | 'invalid_keyring'
  /** `context` is not 1..200 characters of 0x21..0x7e. */
  | 'invalid_context'
  /** Plaintext / value to index is not a non-empty, well-formed (no lone surrogate) string. */
  | 'invalid_plaintext'
  /** The text is not `v1.<key_version>.<payload>` as specified above. */
  | 'malformed_ciphertext'
  /** The ciphertext names a key version the keyring does not hold. */
  | 'unknown_key_version'
  /** Authentication failed: wrong key, wrong context, or altered data. Nothing is returned. */
  | 'decrypt_failed'
  /** The provider's wrapKey / unwrapKey failed; its own error is dropped. */
  | 'key_provider_failed';

/** The one message of each code (the rule tests keep their own copy of this table). */
export const FIELD_CRYPTO_MESSAGES: Readonly<Record<FieldCryptoErrorCode, string>> = Object.freeze({
  invalid_key: 'key has the wrong length',
  invalid_keyring: 'keyring or wrapped key is malformed or belongs to another master key',
  invalid_context: 'context must be 1 to 200 printable ASCII characters',
  invalid_plaintext: 'value must be a non-empty well-formed string',
  malformed_ciphertext: 'text is not a v1 ciphertext',
  unknown_key_version: 'the keyring does not hold this key version',
  decrypt_failed: 'decryption failed',
  key_provider_failed: 'the key provider failed',
});

export class FieldCryptoError extends Error {
  readonly code: FieldCryptoErrorCode;

  constructor(code: FieldCryptoErrorCode, message: string) {
    super(message);
    this.name = 'FieldCryptoError';
    this.code = code;
  }
}

/**
 * Holder of the master key (key-encryption key). The master key never leaves the provider.
 * Implementations: `LocalKeyProvider` (local / test); a KMS-backed one arrives with a later task.
 */
export interface KeyProvider {
  /** Identifies the master key. Stored in the keyring as `key_id`. */
  readonly keyId: string;
  /** Wraps raw key bytes under the master key. The result is opaque text, safe to store. */
  wrapKey(plainKey: Uint8Array): Promise<string>;
  /** Reverses `wrapKey`. Rejects when the text was altered or wrapped under another master key. */
  unwrapKey(wrappedKey: string): Promise<Uint8Array>;
}

/** The stored form of the keys: nothing in it is usable without the provider's master key. */
export interface WrappedKeyring {
  /** `keyId` of the provider whose master key wrapped the entries. */
  readonly key_id: string;
  /** Version new ciphertexts are written with; must be one of `data_keys`. */
  readonly current_version: number;
  /** Data keys, each wrapped; versions are unique integers in 1..2147483647. */
  readonly data_keys: readonly { readonly version: number; readonly wrapped: string }[];
  /** Wrapped HMAC key of the blind index (at least 32 bytes once unwrapped). */
  readonly blind_index_key: string;
}

export interface FieldCrypto {
  /** Key version new ciphertexts carry (`current_version` of the keyring). */
  readonly currentKeyVersion: number;
  /** Encrypts with the current data key; a fresh random IV every call. */
  encrypt(plaintext: string, context: string): string;
  /** Decrypts with the data key the ciphertext names; throws instead of returning wrong text. */
  decrypt(ciphertext: string, context: string): string;
  /**
   * The key version a well-formed ciphertext carries, read without decrypting and without
   * looking the version up in the keyring.
   */
  keyVersionOf(ciphertext: string): number;
  /** True when the ciphertext carries another key version than the current one. */
  needsReencrypt(ciphertext: string): boolean;
  /** Decrypts and encrypts again under the current key version, same context. */
  reencrypt(ciphertext: string, context: string): string;
  /** Deterministic blind index of `value` for de-duplication and lookup. */
  blindIndex(value: string, context: string): string;
}

/**
 * Local / test key provider: wraps with AES-256-GCM under a 32-byte master key held in memory,
 * in the `lk1.<payload>` format above. A master key of another length is refused with
 * `invalid_key`. `unwrapKey` rejects malformed text with `invalid_keyring` and text that does not
 * authenticate (altered, other master key, other `keyId`) with `decrypt_failed`.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly keyId: string;
  readonly #masterKey: Buffer;

  constructor(masterKey: Uint8Array, keyId: string = 'local') {
    validateKey(masterKey, false);
    validateKeyId(keyId);
    this.keyId = keyId;
    this.#masterKey = Buffer.from(masterKey);
    Object.freeze(this);
  }

  async wrapKey(plainKey: Uint8Array): Promise<string> {
    if (!(plainKey instanceof Uint8Array) || plainKey.byteLength === 0) fail('invalid_key');
    return `lk1.${seal(this.#masterKey, plainKey, this.keyId).toString('base64url')}`;
  }

  async unwrapKey(wrappedKey: string): Promise<Uint8Array> {
    if (typeof wrappedKey !== 'string' || !wrappedKey.startsWith('lk1.')) {
      fail('invalid_keyring');
    }
    const payload = decodePayload(wrappedKey.slice(4), 'invalid_keyring');
    return unseal(this.#masterKey, payload, this.keyId);
  }
}

/**
 * A fresh keyring: one random 32-byte data key as version 1 (current) and one random 32-byte
 * blind-index key, both wrapped by `provider`; `key_id` is the provider's `keyId`.
 */
export async function createWrappedKeyring(provider: KeyProvider): Promise<WrappedKeyring> {
  const keyId = provider.keyId;
  validateKeyId(keyId);
  const wrapped = await wrapNewKey(provider);
  const blindIndexKey = await wrapNewKey(provider);
  return {
    key_id: keyId,
    current_version: 1,
    data_keys: [{ version: 1, wrapped }],
    blind_index_key: blindIndexKey,
  };
}

/**
 * Rotation: returns a NEW document with one more random data key whose version is the highest
 * existing version + 1 and which becomes current. Existing entries and the blind-index key are
 * carried over unchanged; the input document is not modified. Validates the input like
 * `openFieldCrypto` does (`invalid_keyring`).
 */
export async function rotateDataKey(
  keyring: WrappedKeyring,
  provider: KeyProvider,
): Promise<WrappedKeyring> {
  const snapshot = snapshotKeyring(keyring, provider);
  const highestVersion = snapshot.data_keys.reduce((max, key) => Math.max(max, key.version), 0);
  if (highestVersion === MAX_VERSION) fail('invalid_keyring');
  const version = highestVersion + 1;
  const wrapped = await wrapNewKey(provider);
  return {
    ...snapshot,
    current_version: version,
    data_keys: [...snapshot.data_keys, { version, wrapped }],
  };
}

/**
 * Validates the document, unwraps every key through `provider` and returns the cipher.
 * Rejects with `invalid_keyring` when the shape is wrong (current version missing, duplicate or
 * out-of-range versions, no data key, `key_id` different from `provider.keyId`), with
 * `invalid_key` when an unwrapped key has the wrong length, and with `key_provider_failed` when
 * the provider fails to unwrap a key. It never returns a cipher that holds only part of the keys.
 */
export async function openFieldCrypto(
  keyring: WrappedKeyring,
  provider: KeyProvider,
): Promise<FieldCrypto> {
  // Copy the validated document before awaiting an external provider: mutations by the caller
  // must not replace keys or the current version halfway through opening it.
  const snapshot = snapshotKeyring(keyring, provider);
  const keys = new Map<number, Buffer>();
  let blindKey: Buffer | undefined;
  try {
    for (const entry of snapshot.data_keys) {
      keys.set(entry.version, await unwrapOwnedKey(provider, entry.wrapped, false));
    }
    blindKey = await unwrapOwnedKey(provider, snapshot.blind_index_key, true);
    return fieldCrypto(snapshot.current_version, keys, blindKey);
  } catch (error) {
    for (const key of keys.values()) key.fill(0);
    blindKey?.fill(0);
    throw error;
  }
}

const MAX_VERSION = 2_147_483_647;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function fail(code: FieldCryptoErrorCode): never {
  throw new FieldCryptoError(code, FIELD_CRYPTO_MESSAGES[code]);
}

function validateKey(key: unknown, blind: boolean): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array) || (blind ? key.byteLength < 32 : key.byteLength !== 32)) {
    fail('invalid_key');
  }
}

function validateKeyId(keyId: unknown): asserts keyId is string {
  if (typeof keyId !== 'string' || keyId.length === 0 || !keyId.isWellFormed()) {
    fail('invalid_keyring');
  }
}

function validVersion(version: unknown): version is number {
  return (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version >= 1 &&
    version <= MAX_VERSION
  );
}

function nonemptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function snapshotKeyring(keyring: WrappedKeyring, provider: KeyProvider): WrappedKeyring {
  if (keyring === null || typeof keyring !== 'object') fail('invalid_keyring');
  const { key_id, current_version, data_keys, blind_index_key } = keyring;
  validateKeyId(key_id);
  if (
    key_id !== provider.keyId ||
    !validVersion(current_version) ||
    !Array.isArray(data_keys) ||
    data_keys.length === 0 ||
    !nonemptyText(blind_index_key)
  )
    fail('invalid_keyring');
  const versions = new Set<number>();
  const entries: { version: number; wrapped: string }[] = [];
  for (const entry of data_keys) {
    if (entry === null || typeof entry !== 'object') fail('invalid_keyring');
    const { version, wrapped } = entry;
    if (!validVersion(version) || versions.has(version) || !nonemptyText(wrapped)) {
      fail('invalid_keyring');
    }
    versions.add(version);
    entries.push({ version, wrapped });
  }
  if (!versions.has(current_version)) fail('invalid_keyring');
  return { key_id, current_version, data_keys: entries, blind_index_key };
}

async function wrapNewKey(provider: KeyProvider): Promise<string> {
  let key: Buffer | undefined;
  try {
    key = randomBytes(32);
    const wrapped = await provider.wrapKey(key);
    if (!nonemptyText(wrapped)) fail('key_provider_failed');
    return wrapped;
  } catch {
    // Even a FieldCryptoError from a provider is untrusted: it may quote secret input.
    return fail('key_provider_failed');
  } finally {
    key?.fill(0);
  }
}

async function unwrapOwnedKey(
  provider: KeyProvider,
  wrapped: string,
  blind: boolean,
): Promise<Buffer> {
  let key: Uint8Array;
  try {
    key = await provider.unwrapKey(wrapped);
  } catch {
    fail('key_provider_failed');
  }
  validateKey(key, blind);
  // The provider may retain or reuse its buffer. Never retain an alias or erase its memory.
  return Buffer.from(key);
}

function validateContext(context: string): void {
  if (
    typeof context !== 'string' ||
    context.length < 1 ||
    context.length > 200 ||
    /[^\x21-\x7e]/u.test(context)
  ) {
    fail('invalid_context');
  }
}

function validatePlaintext(value: string): void {
  if (!nonemptyText(value) || !value.isWellFormed()) fail('invalid_plaintext');
}

function decodePayload(text: string, code: FieldCryptoErrorCode): Buffer {
  if (!nonemptyText(text) || /[^A-Za-z0-9_-]/u.test(text)) fail(code);
  const payload = Buffer.from(text, 'base64url');
  // Node's decoder is permissive; a round trip also rejects unused nonzero trailing bits.
  if (payload.length < IV_BYTES + 1 + TAG_BYTES || payload.toString('base64url') !== text)
    fail(code);
  return payload;
}

function parseCiphertext(ciphertext: string): { version: number; payload: Buffer } {
  if (typeof ciphertext !== 'string') fail('malformed_ciphertext');
  const parts = ciphertext.split('.');
  const [format, versionText, payloadText] = parts;
  if (
    parts.length !== 3 ||
    format !== 'v1' ||
    versionText === undefined ||
    payloadText === undefined ||
    !/^[1-9][0-9]*$/u.test(versionText)
  ) {
    fail('malformed_ciphertext');
  }
  const version = Number(versionText);
  if (!validVersion(version) || String(version) !== versionText) fail('malformed_ciphertext');
  return { version, payload: decodePayload(payloadText, 'malformed_ciphertext') };
}

function seal(key: Uint8Array, plaintext: Uint8Array, context: string): Buffer {
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, encrypted, cipher.getAuthTag()]);
  } catch {
    fail('invalid_key');
  }
}

function unseal(key: Uint8Array, payload: Buffer, context: string): Buffer {
  let pending: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(payload.subarray(-TAG_BYTES));
    pending = decipher.update(payload.subarray(IV_BYTES, -TAG_BYTES));
    // No bytes leave this function until the full authentication tag has been checked.
    return Buffer.concat([pending, decipher.final()]);
  } catch {
    return fail('decrypt_failed');
  } finally {
    pending?.fill(0);
  }
}

function fieldCrypto(
  currentKeyVersion: number,
  keys: Map<number, Buffer>,
  blindKey: Buffer,
): FieldCrypto {
  const currentKey = keys.get(currentKeyVersion) ?? fail('invalid_keyring');

  function encrypt(plaintext: string, context: string): string {
    validateContext(context);
    validatePlaintext(plaintext);
    const bytes = Buffer.from(plaintext, 'utf8');
    try {
      return `v1.${String(currentKeyVersion)}.${seal(currentKey, bytes, context).toString('base64url')}`;
    } finally {
      bytes.fill(0);
    }
  }

  function decrypt(ciphertext: string, context: string): string {
    validateContext(context);
    const { version, payload } = parseCiphertext(ciphertext);
    const key = keys.get(version);
    if (key === undefined) fail('unknown_key_version');
    const bytes = unseal(key, payload, context);
    try {
      // Reject authenticated but non-UTF-8 input instead of silently replacing bytes.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail('decrypt_failed');
    } finally {
      bytes.fill(0);
    }
  }

  function keyVersionOf(ciphertext: string): number {
    return parseCiphertext(ciphertext).version;
  }

  return Object.freeze({
    currentKeyVersion,
    encrypt,
    decrypt,
    keyVersionOf,
    needsReencrypt(ciphertext: string): boolean {
      return keyVersionOf(ciphertext) !== currentKeyVersion;
    },
    reencrypt(ciphertext: string, context: string): string {
      return encrypt(decrypt(ciphertext, context), context);
    },
    blindIndex(value: string, context: string): string {
      validateContext(context);
      validatePlaintext(value);
      try {
        return createHmac('sha256', blindKey)
          .update(context, 'utf8')
          .update(Buffer.from([0]))
          .update(value, 'utf8')
          .digest('hex');
      } catch {
        fail('invalid_key');
      }
    },
  });
}
