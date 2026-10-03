// Field encryption and blind index for personal data (规划/08 BR-ID-33; 规划/02 §12.3, §12.6;
// ADR-0001 §2 鉴权与密钥). SKELETON written by the rule-test author: every function below throws
// `NotImplemented` until task B1-01a implements it. The rule tests in
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
export const FIELD_CRYPTO_MESSAGES: Readonly<Record<FieldCryptoErrorCode, string>> = {
  invalid_key: 'key has the wrong length',
  invalid_keyring: 'keyring or wrapped key is malformed or belongs to another master key',
  invalid_context: 'context must be 1 to 200 printable ASCII characters',
  invalid_plaintext: 'value must be a non-empty well-formed string',
  malformed_ciphertext: 'text is not a v1 ciphertext',
  unknown_key_version: 'the keyring does not hold this key version',
  decrypt_failed: 'decryption failed',
  key_provider_failed: 'the key provider failed',
};

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

  constructor(masterKey: Uint8Array, keyId: string = 'local') {
    this.keyId = keyId;
    void masterKey;
    throw new Error('NotImplemented');
  }

  wrapKey(plainKey: Uint8Array): Promise<string> {
    void plainKey;
    throw new Error('NotImplemented');
  }

  unwrapKey(wrappedKey: string): Promise<Uint8Array> {
    void wrappedKey;
    throw new Error('NotImplemented');
  }
}

/**
 * A fresh keyring: one random 32-byte data key as version 1 (current) and one random 32-byte
 * blind-index key, both wrapped by `provider`; `key_id` is the provider's `keyId`.
 */
export function createWrappedKeyring(provider: KeyProvider): Promise<WrappedKeyring> {
  void provider;
  throw new Error('NotImplemented');
}

/**
 * Rotation: returns a NEW document with one more random data key whose version is the highest
 * existing version + 1 and which becomes current. Existing entries and the blind-index key are
 * carried over unchanged; the input document is not modified. Validates the input like
 * `openFieldCrypto` does (`invalid_keyring`).
 */
export function rotateDataKey(
  keyring: WrappedKeyring,
  provider: KeyProvider,
): Promise<WrappedKeyring> {
  void keyring;
  void provider;
  throw new Error('NotImplemented');
}

/**
 * Validates the document, unwraps every key through `provider` and returns the cipher.
 * Rejects with `invalid_keyring` when the shape is wrong (current version missing, duplicate or
 * out-of-range versions, no data key, `key_id` different from `provider.keyId`), with
 * `invalid_key` when an unwrapped key has the wrong length, and with `key_provider_failed` when
 * the provider fails to unwrap a key. It never returns a cipher that holds only part of the keys.
 */
export function openFieldCrypto(
  keyring: WrappedKeyring,
  provider: KeyProvider,
): Promise<FieldCrypto> {
  void keyring;
  void provider;
  throw new Error('NotImplemented');
}
