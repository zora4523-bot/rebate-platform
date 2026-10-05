// The install_secret the server issues at device registration (BR-ID-09: device_id and
// install_secret are issued by the server, never made up by the client). device_id is a UUIDv7
// from the platform module (`newUuidV7`).
import { randomBytes } from 'node:crypto';

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
