import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { AdminDirectory, AdminDirectoryRow } from '../infra/admin-directory.ts';
import { verifyPhoneContext } from '../domain/step-up-policy.ts';
import { createAdminAccountsReader } from './admin-accounts-read.ts';

const APP = 'couli';
const NOW = '2026-10-09T02:00:00.000Z';

function row(patch: Partial<AdminDirectoryRow> = {}): AdminDirectoryRow {
  return {
    id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01',
    appId: APP,
    loginName: 'ops',
    isSuper: false,
    status: 'active',
    totpBoundAt: null,
    verifyPhoneCipher: null,
    lockedUntil: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    permissionKeys: [],
    ...patch,
  };
}

function reader(rows: AdminDirectoryRow[], total = rows.length) {
  const directory: AdminDirectory = {
    count: vi.fn(async () => total),
    page: vi.fn(async () => rows),
    byId: vi.fn(async (_app: string, id: string) => rows.find((r) => r.id === id)),
  };
  // Stand-in cipher: the "ciphertext" names its context, so a wrong context is caught.
  const crypto = {
    decrypt: vi.fn((cipher: string, context: string) => {
      const [phone, expected] = cipher.split('|');
      if (expected !== context) throw new Error('context mismatch');
      return phone!;
    }),
  };
  const clock = new FixedClock(NOW);
  return {
    directory,
    crypto,
    clock,
    read: createAdminAccountsReader({ clock, directory, crypto }),
  };
}

it('[AC-F1-06m] the list maps rows, offsets by page and keeps the total', async () => {
  const a = row({
    totpBoundAt: new Date(NOW),
    verifyPhoneCipher: Buffer.from(
      `13812345678|${verifyPhoneContext({ appId: APP, adminId: row().id })}`,
    ),
    lockedUntil: new Date('2026-10-09T02:01:00.000Z'),
    permissionKeys: ['fund.adjust', 'user.list', 'gone'],
  });
  const { directory, read } = reader([a], 41);
  const result = await read.list(APP, 3, 20);
  expect(directory.page).toHaveBeenCalledWith(APP, 40, 20);
  expect(directory.count).toHaveBeenCalledWith(APP);
  expect(result).toEqual({
    page: 3,
    pageSize: 20,
    total: 41,
    items: [
      {
        adminId: a.id,
        username: 'ops',
        isSuper: false,
        status: 'active',
        totpBound: true,
        verifyPhoneMasked: '138****5678',
        lockedUntil: new Date('2026-10-09T02:01:00.000Z'),
        permissions: ['user.list', 'fund.adjust'],
        createdAt: a.createdAt,
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('13812345678');
});

it('[AC-F1-06m] a super admin shows no points and an ended lock shows null', async () => {
  const s = row({ isSuper: true, permissionKeys: ['fund.adjust'], lockedUntil: new Date(NOW) });
  const { read } = reader([s]);
  const view = await read.get(APP, s.id);
  expect(view).toMatchObject({ permissions: [], lockedUntil: null, verifyPhoneMasked: null });
});

it('[AC-F1-06m] a malformed admin id is unknown without touching the database', async () => {
  const { directory, read } = reader([row()]);
  for (const id of ['unknown', '123', '00000000-0000-4000-8000-zzzzzzzzzzzz']) {
    expect(await read.get(APP, id)).toBeUndefined();
  }
  expect(directory.byId).not.toHaveBeenCalled();
  expect(await read.get(APP, '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b99')).toBeUndefined();
});

it('[AC-F1-06m] a verify phone that does not decrypt under its context fails instead of leaking', async () => {
  const bad = row({ verifyPhoneCipher: Buffer.from('13812345678|admin_users.verify_phone:other') });
  const { read } = reader([bad]);
  await expect(read.get(APP, bad.id)).rejects.toThrow('context mismatch');
});
