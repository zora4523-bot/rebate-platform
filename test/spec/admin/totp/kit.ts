import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
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

// RFC 6238 Appendix B 公开测试种子（ASCII "12345678901234567890"），非密钥；运行时按 RFC 4648 编成 Base32。
export const RFC_KEY_BASE32 = rfc4648Base32(Buffer.from('12345678901234567890', 'ascii'));
function rfc4648Base32(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) ?? [])
    .map((g) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(g.padEnd(5, '0'), 2)])
    .join('');
}
export const ACCOUNT: TotpAccount = {
  appId: 'couli',
  adminId: '019a0000-0000-7000-8000-000000000001',
};

export function context(account: TotpAccount): string {
  return `admin_users.totp_secret:${account.appId}:${account.adminId}`;
}

/** Test double only. Production backing/storage is deliberately not prescribed here. */
export function replayFixture() {
  const consumed = new Set<string>();
  const consume = vi.fn(async (claim: TotpClaim): Promise<boolean> => {
    const key = JSON.stringify([claim.appId, claim.adminId, claim.timeStep.toString()]);
    if (consumed.has(key)) return false;
    consumed.add(key);
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
    Buffer.from(fields.encrypt(RFC_KEY_BASE32, context(account)), 'utf8');
  return { crypto: { decrypt }, decrypt, encryptFor };
}

export async function fixture(seconds = 59) {
  const fields = await cryptoFixture();
  return {
    ...fields,
    ...replayFixture(),
    clock: new FixedClock(new Date(seconds * 1000)),
    secretCipher: fields.encryptFor(ACCOUNT),
  };
}
