// Opaque id of an audit record (B1-34a; contract AdminAuditLogId; ADR-0001: internal
// auto-increment keys are never exposed). The wire value is `aud_` + base64url of one AES-128
// block: an 8-byte fixed label followed by the bigint primary key (unsigned big-endian), encrypted
// without IV or padding. The encoding is deterministic (one record, one id, for its whole life)
// and reversible; the ciphertext shows neither the key nor its order. Decoding checks the label,
// so an altered, truncated or foreign value is refused (forging one takes about 2^64 tries).
//
// Key: the keyring's blind index of a fixed label under the fixed context `audit-log-id` (the
// catalog search-cursor precedent): every instance of a deployment derives the same bytes, and a
// data-key rotation keeps them (the blind-index key is carried over); another keyring gives other
// ids, and the old ones no longer decode.
//
// Pure module (no decorators, erasable syntax).
import { createCipheriv, createDecipheriv } from 'node:crypto';
import type { FieldCrypto } from '../../platform/index.ts';

export interface AuditLogIdCodec {
  encode(id: bigint): string;
  /** The primary key, or undefined for any value this codec did not produce. */
  decode(value: string): bigint | undefined;
}

const PREFIX = 'aud_';
const WIRE = /^aud_[A-Za-z0-9_-]{22}$/;
const LABEL = Buffer.from('couliaud', 'ascii');
const BIGINT_MAX = (1n << 63n) - 1n;
const KEY_CONTEXT = 'audit-log-id';
const KEY_LABEL = 'couli.admin.audit_log_id.v1';

/** The deployment's 16-byte key, derived from the field keyring (see the header). */
export function keyringAuditLogIdKey(crypto: Pick<FieldCrypto, 'blindIndex'>): Buffer {
  return Buffer.from(crypto.blindIndex(KEY_LABEL, KEY_CONTEXT), 'hex').subarray(0, 16);
}

export function createAuditLogIdCodec(key: Uint8Array): AuditLogIdCodec {
  if (!(key instanceof Uint8Array) || key.length !== 16) {
    throw new TypeError('audit log id: key must have exactly 16 bytes');
  }
  // A private copy: later changes to the caller's buffer do not change this codec.
  const secret = Buffer.from(key);
  const block = (decrypt: boolean, input: Buffer): Buffer => {
    const cipher = decrypt
      ? createDecipheriv('aes-128-ecb', secret, null)
      : createCipheriv('aes-128-ecb', secret, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(input), cipher.final()]);
  };

  return {
    encode(id) {
      if (typeof id !== 'bigint' || id < 1n || id > BIGINT_MAX) {
        throw new RangeError('audit log id: primary key out of range');
      }
      const plain = Buffer.alloc(16);
      LABEL.copy(plain, 0);
      plain.writeBigUInt64BE(id, 8);
      return `${PREFIX}${block(false, plain).toString('base64url')}`;
    },
    decode(value) {
      if (typeof value !== 'string' || !WIRE.test(value)) return undefined;
      const text = value.slice(PREFIX.length);
      const bytes = Buffer.from(text, 'base64url');
      // Only the canonical spelling: the last character's unused bits must be zero.
      if (bytes.length !== 16 || bytes.toString('base64url') !== text) return undefined;
      const plain = block(true, bytes);
      if (!plain.subarray(0, 8).equals(LABEL)) return undefined;
      const id = plain.readBigUInt64BE(8);
      return id >= 1n && id <= BIGINT_MAX ? id : undefined;
    },
  };
}
