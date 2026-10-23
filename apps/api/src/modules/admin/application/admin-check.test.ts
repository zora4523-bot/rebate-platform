import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { FixedClock, type RequestCheckInput } from '../../platform/index.ts';
import type { AdminAccount, AdminAccounts } from '../infra/admin-accounts.ts';
import type { AdminRevocations } from '../infra/admin-revocations.ts';
import type { AdminSessions, SessionRecord } from '../infra/admin-sessions.ts';
import { createAdminRequestCheck } from './admin-check.ts';
import { createAdminTokens } from './admin-tokens.ts';

const APP = 'couli';
const ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';

async function setup(account: Partial<AdminAccount>, voidedAt: number | null) {
  const clock = new FixedClock('2026-10-09T02:00:00.000Z');
  const tokens = createAdminTokens({ key: new Uint8Array(randomBytes(32)), clock });
  const { token, claims } = await tokens.issue({ adminId: ID, appId: APP });
  const record: SessionRecord = {
    adminId: ID,
    appId: APP,
    expiresAtMs: claims.expiresAt * 1000,
    lastSeenMs: clock.now().getTime(),
  };
  const sessions: AdminSessions = {
    create: async () => undefined,
    read: async () => record,
    touch: async () => true,
    revoke: async () => undefined,
  };
  const row: AdminAccount = {
    id: ID,
    appId: APP,
    loginName: 'ops',
    passwordHash: 'x',
    totpSecretCipher: Buffer.from('c'),
    totpBoundAt: new Date('2026-10-01T00:00:00.000Z'),
    isSuper: false,
    status: 'active',
    passwordMustChange: false,
    failedLoginCount: 0,
    lockedUntil: null,
    ...account,
  };
  const accounts = { byId: async () => row } as unknown as AdminAccounts;
  const revocations: AdminRevocations = {
    voidBefore: async () => undefined,
    voidedAt: async () => voidedAt,
  };
  const check = createAdminRequestCheck({
    clock,
    allows: () => true,
    tokens,
    sessions: () => sessions,
    accounts: () => accounts,
    revocations: () => revocations,
  });
  const input: RequestCheckInput = {
    id: 'trace',
    method: 'GET',
    url: '/admin/v1/me/permissions',
    routeTemplate: '/admin/v1/me/permissions',
    ip: '127.0.0.1',
    headers: { authorization: `Bearer ${token}` },
    rawBody: Buffer.alloc(0),
  };
  return { check, input, issuedAtMs: claims.issuedAt * 1000 };
}

it('[AC-B1-34h] a live, bound account issued after any void passes', async () => {
  const { check, input, issuedAtMs } = await setup({}, null);
  await expect(check(input)).resolves.toBeUndefined();
  const later = await setup({}, issuedAtMs);
  await expect(later.check(later.input)).resolves.toBeUndefined();
});

it('[AC-B1-34h] a token issued before the voiding instant is 10001', async () => {
  const { check, input, issuedAtMs } = await setup({}, null);
  const voided = await setup({}, issuedAtMs + 1);
  await expect(voided.check(voided.input)).rejects.toMatchObject({ code: 10001 });
  await expect(check(input)).resolves.toBeUndefined();
});

it('[AC-B1-34h] an account whose authenticator is no longer bound is 10001', async () => {
  const { check, input } = await setup({ totpBoundAt: null }, null);
  await expect(check(input)).rejects.toMatchObject({ code: 10001 });
});
