import { createTestDatabase } from '@couli/db/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect, it, vi } from 'vitest';
import { createExportUsersReader } from '../../../../apps/api/src/modules/identity/application/export-users.ts';
import { PHONE_CIPHER_CONTEXT } from '../../../../apps/api/src/modules/identity/domain/registration.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { databaseHarness, START } from './kit.ts';

const h = databaseHarness(createTestDatabase);

async function setup() {
  const provider = new LocalKeyProvider(randomBytes(32));
  const crypto = await openFieldCrypto(await createWrappedKeyring(provider), provider);
  const decrypt = vi.fn((ciphertext: string, context: string) =>
    crypto.decrypt(ciphertext, context),
  );
  const queries: string[] = [];
  const db = h.db().withPlugin({
    transformQuery({ node }) {
      queries.push(JSON.stringify(node));
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const appId = `u_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const plain = ['138', '2468', '5678'].join('');
  async function user(patch: Partial<Insertable<DB['users']>> = {}) {
    return db
      .insertInto('users')
      .values({
        id: randomUUID(),
        app_id: appId,
        attr_code: randomUUID(),
        invite_code: randomUUID(),
        nickname: '演示用户',
        avatar: 'https://example.invalid/avatar',
        level: 'L1',
        phone_cipher: Buffer.from(crypto.encrypt(plain, PHONE_CIPHER_CONTEXT)),
        phone_hmac: null,
        parent_id: null,
        parent_bind_source: null,
        parent_bound_at: null,
        registered_channel: null,
        register_method: 'sms',
        nickname_change_month: null,
        deleted_reason: null,
        created_at: START,
        updated_at: START,
        ...patch,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  const reader = () =>
    createExportUsersReader({
      db,
      crypto: {
        currentKeyVersion: crypto.currentKeyVersion,
        encrypt: (plaintext, context) => crypto.encrypt(plaintext, context),
        decrypt,
        keyVersionOf: (ciphertext) => crypto.keyVersionOf(ciphertext),
        needsReencrypt: (ciphertext) => crypto.needsReencrypt(ciphertext),
        reencrypt: (ciphertext, context) => crypto.reencrypt(ciphertext, context),
        blindIndex: (value, context) => crypto.blindIndex(value, context),
      },
    });
  return { db, appId, crypto, decrypt, queries, plain, user, reader };
}

it('[AC-B1-34e#22] identity defaults to masked phone and whitelists only source-list columns', async () => {
  const f = await setup();
  const reader = f.reader();
  const row = await f.user();
  const page = await reader.page({ appId: f.appId, page: 1, pageSize: 50 });
  expect(page.total).toBe(1);
  expect(page.items).toEqual([
    {
      user_id: row.id,
      nickname: row.nickname,
      phone: '138****5678',
      level: 'L1',
      risk_state: 'normal',
      created_at: START,
    },
  ]);
  expect(JSON.stringify(page)).not.toContain(f.plain);
  expect(JSON.stringify(page)).not.toContain(row.phone_cipher!.toString('utf8'));
});

it('[AC-B1-34e#23] masked=false decrypts a whole batch in identity without per-user database reads', async () => {
  const f = await setup();
  const reader = f.reader();
  const rows = await Promise.all(Array.from({ length: 25 }, () => f.user()));
  await f.user({ app_id: 'other_export_app' });
  f.queries.splice(0);
  f.decrypt.mockClear();
  const page = await reader.page({ appId: f.appId, page: 1, pageSize: 50, masked: false });
  expect(page.total).toBe(25);
  expect(page.items.map((row) => row.user_id).sort()).toEqual(rows.map((row) => row.id).sort());
  expect(page.items.every((row) => row.phone === f.plain)).toBe(true);
  expect(f.decrypt).toHaveBeenCalledTimes(25);
  for (const call of f.decrypt.mock.calls) expect(call[1]).toBe(PHONE_CIPHER_CONTEXT);
  // A count plus bounded batch projection/risk reads; an N+1 reader exceeds this bound.
  expect(f.queries.length).toBeLessThanOrEqual(5);
  expect(f.queries.length).toBeGreaterThan(0);
  for (const row of page.items)
    expect(Object.keys(row).sort()).toEqual(
      ['user_id', 'nickname', 'phone', 'level', 'risk_state', 'created_at'].sort(),
    );
});

it('[AC-B1-34e#24] identity filters risk_state including implicit normal, paginates stably and isolates apps', async () => {
  const f = await setup();
  const reader = f.reader();
  const implicit = await f.user({ phone_cipher: null });
  const explicit = await f.user();
  const frozen = await f.user();
  const foreign = await f.user({ app_id: 'foreign_projection_app' });
  for (const [user, state] of [
    [explicit, 'normal'],
    [frozen, 'frozen'],
    [foreign, 'frozen'],
  ] as const) {
    await f.db
      .insertInto('user_risk_state')
      .values({
        user_id: user.id,
        app_id: user.app_id,
        state,
        reason: null,
        reason_category: state === 'normal' ? null : 'other',
        frozen_until: null,
        changed_by: 'synthetic-test',
        changed_at: START,
        created_at: START,
        updated_at: START,
      })
      .execute();
  }
  const normal = await reader.page({ appId: f.appId, page: 1, pageSize: 10, riskState: 'normal' });
  expect(normal.total).toBe(2);
  expect(normal.items.map((row) => row.user_id).sort()).toEqual([implicit.id, explicit.id].sort());
  expect(normal.items.find((row) => row.user_id === implicit.id)?.phone).toBeNull();
  const filtered = await reader.page({
    appId: f.appId,
    page: 1,
    pageSize: 10,
    riskState: 'frozen',
    masked: false,
  });
  expect(filtered.total).toBe(1);
  expect(filtered.items.map((row) => row.user_id)).toEqual([frozen.id]);
  const pages = await Promise.all(
    [1, 2, 3].map((page) => reader.page({ appId: f.appId, page, pageSize: 1 })),
  );
  expect(pages.flatMap((page) => page.items.map((row) => row.user_id))).toEqual(
    [implicit.id, explicit.id, frozen.id].sort().reverse(),
  );
  expect(pages.every((page) => page.total === 3)).toBe(true);
});

it('[AC-B1-34e#25] a broken cipher fails closed rather than exporting cipher text or partial plaintext', async () => {
  const f = await setup();
  const reader = f.reader();
  await f.user({ phone_cipher: Buffer.from('invalid-synthetic-cipher') });
  await expect(
    reader.page({ appId: f.appId, page: 1, pageSize: 20, masked: false }),
  ).rejects.toThrow();
  await expect(reader.page({ appId: f.appId, page: 1, pageSize: 20 })).rejects.toThrow();
});
