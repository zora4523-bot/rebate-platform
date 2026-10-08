// B1-05g ②: signed search cursor. The wire value is `<payload>.<mac>`, both base64url: payload is
// the JSON of exactly { search_session_id, page_no } (BR-PROD-07 游标), mac is HMAC-SHA256 over the
// payload segment under the deployment's signing key. A forged, altered or truncated cursor, or one
// signed under another key, decodes to undefined, which the use case answers with 20001 before any
// union call. The page cap is the use case's (SEARCH_MAX_PAGE_NO).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FieldCrypto } from '../../platform/index.ts';
import type { SearchCursor, SearchCursorCodec } from '../search.ts';

const MAC_DOMAIN = 'couli.catalog.search_cursor.v1';
const WIRE = /^([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/;
const MIN_KEY_BYTES = 16;

/** Shared deployment key: independent staging / prod instances receive the same bytes. */
export function createSignedSearchCursorCodec(signingKey: Uint8Array): SearchCursorCodec {
  if (!(signingKey instanceof Uint8Array) || signingKey.length < MIN_KEY_BYTES) {
    throw new TypeError('search cursor: signing key must have at least 16 bytes');
  }
  // A private copy: later changes to the caller's buffer do not change this codec.
  const key = Buffer.from(signingKey);
  const mac = (payload: string): Buffer =>
    createHmac('sha256', key).update(MAC_DOMAIN).update('.').update(payload, 'utf8').digest();

  return {
    encode(value: SearchCursor): string {
      const payload = Buffer.from(
        JSON.stringify({ search_session_id: value.search_session_id, page_no: value.page_no }),
        'utf8',
      ).toString('base64url');
      return `${payload}.${mac(payload).toString('base64url')}`;
    },
    decode(value: string): unknown {
      const match = typeof value === 'string' ? WIRE.exec(value) : null;
      if (match === null) return undefined;
      const payload = match[1]!;
      const given = Buffer.from(match[2]!, 'base64url');
      const expected = mac(payload);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
      try {
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
      } catch {
        return undefined;
      }
    },
  };
}

let processKey: Uint8Array | undefined;

/**
 * local / test processes without a field keyring: one random signing key per process, generated
 * on first use and never replaced (the same scope as processItemRefCipher, B1-05k), so every
 * module instance of the process — including an application rebuilt in the same process —
 * verifies the cursors of the others. A restart invalidates outstanding cursors (20001 → page 1).
 */
export function processSearchCursorKey(): Uint8Array {
  processKey ??= randomBytes(32);
  return processKey;
}

/** Context of the keyring-derived signing key; printable ASCII (FieldCrypto contexts). */
const KEYRING_CONTEXT = 'catalog.search_cursor.signing_key.v1';

/**
 * staging / prod (and any process with a field keyring): the signing key is the keyring's
 * deterministic blind index of a fixed label, so every instance of the deployment derives the
 * same bytes, the key survives restarts and data-key rotation (the blind-index key is carried
 * over), and nothing is generated per module instance or per process.
 */
export function keyringSearchCursorKey(crypto: Pick<FieldCrypto, 'blindIndex'>): Uint8Array {
  return Buffer.from(crypto.blindIndex(MAC_DOMAIN, KEYRING_CONTEXT), 'utf8');
}
