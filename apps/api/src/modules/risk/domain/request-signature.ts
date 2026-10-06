// The request signature of 规划/08 BR-ID-09 (shared vectors: specs/request-sign.vectors.json; header
// patterns: contracts/openapi.yaml Timestamp, Nonce, Sign). Pure: no Nest, no I/O, no clock read
// (the caller passes the injected Clock's time), no logging.
//
// Signing string = upper-case method + "\n" + path without scheme or host, with the raw query
// string exactly as sent + "\n" + X-Timestamp + "\n" + X-Nonce + "\n" + lowercase_hex(sha256(raw
// body bytes)); X-Sign = lowercase_hex(HMAC-SHA256(UTF-8 bytes of install_secret, signing string)).
// The signing string is fed to the HMAC piece by piece and never held as one value, so it cannot
// end up in an error, a log line or a response.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`, no NestJS, no decorators.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** |server time − X-Timestamp| may be at most this many seconds (both bounds included). */
export const SIGNATURE_SKEW_SECONDS = 300;
/** (device_id, nonce) may not repeat within this many seconds. */
export const NONCE_TTL_SECONDS = 600;

/** Unix seconds, exactly 10 digits. */
const TIMESTAMP = /^[0-9]{10}$/;
/** 32 lower-case hex characters. */
const NONCE = /^[0-9a-f]{32}$/;
/** 64 lower-case hex characters: an upper-case X-Sign is refused like any other mismatch. */
const SIGNATURE = /^[0-9a-f]{64}$/;

export function isWellFormedTimestamp(value: string | undefined): value is string {
  return value !== undefined && TIMESTAMP.test(value);
}

export function isWellFormedNonce(value: string | undefined): value is string {
  return value !== undefined && NONCE.test(value);
}

export function isWellFormedSignature(value: string | undefined): value is string {
  return value !== undefined && SIGNATURE.test(value);
}

/** Whole server seconds (floor of the injected clock) against a well-formed X-Timestamp. */
export function isWithinSkew(timestamp: string, nowMs: number): boolean {
  const serverSeconds = Math.floor(nowMs / 1000);
  return Math.abs(serverSeconds - Number(timestamp)) <= SIGNATURE_SKEW_SECONDS;
}

export interface SignedParts {
  readonly method: string;
  /** Origin-form request target as received: path plus the raw query string. */
  readonly url: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly body: Buffer;
}

/** The 32 raw bytes of HMAC-SHA256(install_secret, signing string). */
export function expectedSignature(installSecret: string, parts: SignedParts): Buffer {
  const bodyHash = createHash('sha256').update(parts.body).digest('hex');
  return createHmac('sha256', Buffer.from(installSecret, 'utf8'))
    .update(parts.method.toUpperCase())
    .update('\n')
    .update(parts.url)
    .update('\n')
    .update(parts.timestamp)
    .update('\n')
    .update(parts.nonce)
    .update('\n')
    .update(bodyHash)
    .digest();
}

/**
 * Timing-safe comparison of a well-formed X-Sign (see isWellFormedSignature) with the expected
 * HMAC. A length difference answers false without calling timingSafeEqual (which would throw).
 */
export function signatureMatches(signature: string, expected: Buffer): boolean {
  const provided = Buffer.from(signature, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
