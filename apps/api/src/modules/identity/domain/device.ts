// Device registration rules (规划/08 BR-ID-09 and its 细则「设备标识的无效值」; 规划/04 §3.2 devices,
// §6.1 POST /v1/devices). Pure TypeScript: no Nest, no data access, no randomness.

/**
 * device_hash = lowercase_hex(SHA-256(identifier trimmed and lower-cased)): exactly 64 lowercase
 * hex characters. The request schema enforces the same pattern; this is the domain's own check.
 */
const DEVICE_HASH = /^[0-9a-f]{64}$/;

export function isWellFormedDeviceHash(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_HASH.test(value);
}

/**
 * A hash may be registered when it is well formed and not on the invalid-hash list (config
 * device.invalid_hashes: hashes of empty, all-zero and known public fixed identifiers). A hash
 * that fails either check is 20001 with data.fields=[device_hash] and gets no device_id.
 */
export function isRegistrableDeviceHash(
  deviceHash: string,
  invalidHashes: ReadonlySet<string>,
): boolean {
  return isWellFormedDeviceHash(deviceHash) && !invalidHashes.has(deviceHash);
}

/**
 * Field-encryption context of devices.install_secret_cipher. It names the column and binds the
 * ciphertext to its row, so a ciphertext copied onto another device row does not decrypt there.
 * Request-signature verification (B1-03b, DeviceSigningKeysService) decrypts with the same context.
 */
export function installSecretContext(deviceId: string): string {
  return `devices.install_secret:${deviceId}`;
}

/** A device_id as the server issues it: a UUID in canonical lower-case form (platform newUuidV7). */
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * X-Device-Id may name a server-issued device only in the form the server returned it
 * (BR-ID-09: only issued values are accepted). Anything else is answered without a lookup: it
 * cannot be issued, and the uuid column would refuse it.
 */
export function isWellFormedDeviceId(value: string): boolean {
  return DEVICE_ID.test(value);
}
