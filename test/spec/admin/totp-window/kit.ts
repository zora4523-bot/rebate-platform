// B1-34l rule-test kit (编排裁定 D10-238: inside the ±1 window, every matched step is tried in
// ascending order until one is consumed). It holds an adjacent-step code collision found
// offline, an independent RFC 4226 reference (node:crypto HMAC-SHA1, nothing from the module
// under test) that re-checks it inside every test, and a per-step replay double.
// Nothing here imports the test-database base (`@couli/db/testing`): only *.int.test.ts may.
import { createHmac, randomBytes } from 'node:crypto';
import { expect, vi } from 'vitest';
import {
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  TotpAccount,
  TotpClaim,
  TotpReplayStore,
} from '../../../../apps/api/src/modules/admin/domain/totp.ts';

// RFC 6238 Appendix B 公开测试种子（ASCII "12345678901234567890"），非密钥。
export const SEED_ASCII = '12345678901234567890';
/** The same seed in unpadded upper-case Base32 (RFC 4648), as stored after decryption. */
export const COLLISION_KEY_BASE32 = referenceBase32Encode(Buffer.from(SEED_ASCII, 'ascii'));
/** Counters N-1 and N found offline: the six-digit HOTP of both is COLLISION_CODE. */
export const PREVIOUS_STEP = 59061240n;
export const COLLISION_STEP = 59061241n;
export const COLLISION_CODE = '963181';
/** Unix seconds at which step N starts (N × 30). */
export const COLLISION_STEP_START = 1771837230;

/** Clock positions (epoch ms) whose ±1 window holds both N-1 and N. */
export const COLLISION_INSTANTS = [
  ['first millisecond of step N', COLLISION_STEP_START * 1000],
  ['last millisecond of step N', COLLISION_STEP_START * 1000 + 29_999],
  ['middle of step N-1', COLLISION_STEP_START * 1000 - 15_000],
] as const;

export const ACCOUNT: TotpAccount = {
  appId: 'couli',
  adminId: '019a0000-0000-7000-8000-0000000034a1',
};

export function claim(timeStep: bigint, account: TotpAccount = ACCOUNT): TotpClaim {
  return { appId: account.appId, adminId: account.adminId, timeStep };
}

/** Field-encryption context of admin_users.totp_secret_cipher, written out independently. */
export function context(account: TotpAccount): string {
  return `admin_users.totp_secret:${account.appId}:${account.adminId}`;
}

/** RFC 4648 Base32 decoding, independent of the module under test. */
export function referenceBase32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...text].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** RFC 4648 Base32 encoding without padding, the inverse of referenceBase32. */
export function referenceBase32Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  return (bits.match(/.{1,5}/g) ?? [])
    .map((group) => alphabet.charAt(parseInt(group.padEnd(5, '0'), 2)))
    .join('');
}

/** RFC 4226 HOTP with node:crypto HMAC-SHA1, independent of the module under test. */
export function referenceHotp(key: Uint8Array, counter: bigint, digits: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Re-checks the offline constants with the reference: the reference itself first against
 * RFC 4226 Appendix D, then N-1 and N share the code while N-2 and N+1 do not (so each clock
 * position in COLLISION_INSTANTS matches exactly the steps N-1 and N), and N starts at
 * COLLISION_STEP_START.
 */
export function expectCollision(): void {
  const key = referenceBase32(COLLISION_KEY_BASE32);
  expect(key.toString('ascii')).toBe(SEED_ASCII);
  expect([0n, 1n, 2n, 9n].map((c) => referenceHotp(key, c, 6))).toEqual([
    '755224',
    '287082',
    '359152',
    '520489',
  ]);
  expect(COLLISION_STEP - PREVIOUS_STEP).toBe(1n);
  expect(referenceHotp(key, PREVIOUS_STEP, 6)).toBe(COLLISION_CODE);
  expect(referenceHotp(key, COLLISION_STEP, 6)).toBe(COLLISION_CODE);
  expect(referenceHotp(key, PREVIOUS_STEP - 1n, 6)).not.toBe(COLLISION_CODE);
  expect(referenceHotp(key, COLLISION_STEP + 1n, 6)).not.toBe(COLLISION_CODE);
  expect(BigInt(COLLISION_STEP_START)).toBe(COLLISION_STEP * 30n);
}

/** Test double: per-step bookkeeping; `used` claims count as consumed from the start. */
export function replayFixture(used: readonly TotpClaim[] = []) {
  const keyOf = (c: TotpClaim) => JSON.stringify([c.appId, c.adminId, c.timeStep.toString()]);
  const consumed = new Set<string>(used.map(keyOf));
  const consume = vi.fn(async (c: TotpClaim): Promise<boolean> => {
    if (consumed.has(keyOf(c))) return false;
    consumed.add(keyOf(c));
    return true;
  });
  const replay: TotpReplayStore = { consume };
  return { replay, consume };
}

export async function cryptoFixture() {
  const provider = new LocalKeyProvider(randomBytes(32));
  const fields = await openFieldCrypto(await createWrappedKeyring(provider), provider);
  const decrypt = vi.fn((cipher: string, aad: string) => fields.decrypt(cipher, aad));
  const encryptFor = (account: TotpAccount) =>
    Buffer.from(fields.encrypt(COLLISION_KEY_BASE32, context(account)), 'utf8');
  return { crypto: { decrypt }, decrypt, encryptFor };
}

/** Clock at `epochMs`, the collision secret encrypted for ACCOUNT, replay with `used` claims. */
export async function fixture(epochMs: number, used: readonly TotpClaim[] = []) {
  const fields = await cryptoFixture();
  return {
    ...fields,
    ...replayFixture(used),
    clock: new FixedClock(new Date(epochMs)),
    secretCipher: fields.encryptFor(ACCOUNT),
  };
}
