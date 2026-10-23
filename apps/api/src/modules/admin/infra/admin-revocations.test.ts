import { expect, it, vi } from 'vitest';
import type { RedisNamespace } from '../../platform/index.ts';
import {
  ADMIN_REVOCATION_TTL_SEC,
  createAdminRevocations,
  issuedBeforeVoid,
} from './admin-revocations.ts';

const account = { appId: 'couli', adminId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01' };

it('[AC-B1-34h] only credentials issued strictly before the voiding instant are void', () => {
  expect(issuedBeforeVoid(999, null)).toBe(false);
  expect(issuedBeforeVoid(999, 1000)).toBe(true);
  expect(issuedBeforeVoid(1000, 1000)).toBe(false);
  expect(issuedBeforeVoid(1001, 1000)).toBe(false);
});

it('[AC-B1-34h] the instant is written per account with the token lifetime, and read back', async () => {
  const store = new Map<string, string>();
  const redis: RedisNamespace = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async () => undefined),
    eval: vi.fn(async (_script: string, options) => {
      store.set(options.keys[0]!, options.args[0]!);
      return 1;
    }),
  };
  const revocations = createAdminRevocations({ redis });
  expect(await revocations.voidedAt(account)).toBeNull();
  await revocations.voidBefore(account, 1234);
  expect(redis.eval).toHaveBeenCalledWith(expect.any(String), {
    keys: [`revoked:${account.appId}:${account.adminId}`],
    args: ['1234'],
    ttlSeconds: ADMIN_REVOCATION_TTL_SEC,
  });
  expect(await revocations.voidedAt(account)).toBe(1234);
  expect(await revocations.voidedAt({ ...account, adminId: 'other' })).toBeNull();
});

it('[AC-B1-34h] an unreadable record voids everything (fail closed)', async () => {
  const redis: RedisNamespace = {
    get: vi.fn(async () => 'garbage'),
    set: vi.fn(async () => undefined),
    eval: vi.fn(async () => 1),
  };
  const at = await createAdminRevocations({ redis }).voidedAt(account);
  expect(issuedBeforeVoid(Date.now(), at)).toBe(true);
});
