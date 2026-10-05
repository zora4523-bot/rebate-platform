// Values the server issues at device registration (BR-ID-09: device_id and install_secret are
// issued by the server, never made up by the client).
import { randomBytes } from 'node:crypto';

const MAX_UUIDV7_MS = 2 ** 48 - 1;

/**
 * A UUIDv7 (RFC 9562 §5.7; ADR-0001 §4.2 #1, 04 §5: entity ids are UUIDv7): the 48-bit big-endian
 * Unix time in milliseconds of `now`, version 7, variant 10 and 74 fresh random bits; lower-case
 * canonical text. Same layout as platform/events `newEventId`, which is not part of the platform
 * module's public surface.
 */
export function newDeviceId(now: Date): string {
  const ms = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_UUIDV7_MS) {
    throw new Error('newDeviceId: now must be a valid instant within the UUIDv7 range');
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Random bytes behind one install_secret: 256 bits. */
export const INSTALL_SECRET_BYTES = 32;

/**
 * A new install_secret: 32 bytes from the system CSPRNG as base64url without padding
 * (43 characters, within the contract's 16..128). The key of the request-signature HMAC.
 */
export function newInstallSecret(): string {
  const bytes = randomBytes(INSTALL_SECRET_BYTES);
  try {
    return bytes.toString('base64url');
  } finally {
    bytes.fill(0);
  }
}
