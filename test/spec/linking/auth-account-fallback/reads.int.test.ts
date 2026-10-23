import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { createUnionAuthReads } from '../../../../apps/api/src/modules/linking/application/union-auth-reads.ts';
import { createLinkingPidReader } from '../../../../apps/api/src/modules/linking/infra/pid-reader.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  FIRST_CREATED,
  LATER_UPDATED,
  activeSlot,
  databaseFixture,
  driftedAccounts,
  insertAccount,
  orderedIds,
} from './kit.ts';

// B1-22l (D10-239 ①): the shared "account this authorization uses" (union-auth-reads.ts
// authAccountId), read against real union_accounts / union_pids rows through union's own
// read-only active-pid query.
const database = databaseFixture(createTestDatabase);
const NOW = '2026-10-23T00:00:00.000Z';

function reads(db: Kysely<DB>) {
  return createUnionAuthReads({
    db,
    config: { configValue: async () => null },
    appEnv: 'test',
    pids: createLinkingPidReader(db, new FixedClock(NOW)),
  });
}

function tenant(): string {
  return `synthetic_fallback_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

it.each(['taobao', 'pdd'] as const)(
  '[B1-22l] %s：无绑定、无 active self_buy 推广位时取最早登记（created_at 最早）的账号，不因它最近更新而改选',
  async (platform) => {
    const db = database();
    const appId = tenant();
    const { first, later } = await driftedAccounts(db, appId, platform, {
      first: 'active',
      later: 'active',
    });
    // Another app's and another platform's even older accounts are out of scope.
    const before = new Date(FIRST_CREATED.getTime() - 86_400_000);
    await insertAccount(db, {
      appId: tenant(),
      platform,
      authStatus: 'active',
      createdAt: before,
      updatedAt: before,
    });
    await insertAccount(db, {
      appId,
      platform: platform === 'taobao' ? 'pdd' : 'taobao',
      authStatus: 'active',
      createdAt: before,
      updatedAt: before,
    });
    const selected = await reads(db).authAccountId(appId, platform, null);
    expect(selected).not.toBe(later);
    expect(selected).toBe(first);
  },
  60_000,
);

it.each(['taobao', 'pdd'] as const)(
  '[B1-22l] %s：created_at 相同时按 id 升序，与 updated_at 无关',
  async (platform) => {
    const db = database();
    const appId = tenant();
    const [low, high] = orderedIds();
    // The higher id was updated earlier: an order that still reads updated_at first picks it.
    await insertAccount(db, {
      id: high,
      appId,
      platform,
      authStatus: 'active',
      createdAt: FIRST_CREATED,
      updatedAt: LATER_UPDATED,
    });
    await insertAccount(db, {
      id: low,
      appId,
      platform,
      authStatus: 'active',
      createdAt: FIRST_CREATED,
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(await reads(db).authAccountId(appId, platform, null)).toBe(low);
  },
  60_000,
);

it.each(['taobao', 'pdd'] as const)(
  '[B1-22l] %s：未释放绑定的账号与 self_buy 推广位所属账号仍先于兜底；两者都没有才取最早登记的账号',
  async (platform) => {
    const db = database();
    const appId = tenant();
    const { first, later } = await driftedAccounts(db, appId, platform, {
      first: 'active',
      later: 'active',
    });
    // Neither the earliest-registered nor the earliest-updated account.
    const third = await insertAccount(db, {
      appId,
      platform,
      authStatus: 'active',
      createdAt: new Date('2025-08-01T00:00:00.000Z'),
      updatedAt: new Date('2025-09-01T00:00:00.000Z'),
    });
    const r = reads(db);
    // ① the unreleased binding's account, even with no slot anywhere.
    expect(await r.authAccountId(appId, platform, third)).toBe(third);
    // ② the account of the platform's active self_buy slot.
    const slot = await activeSlot(db, {
      appId,
      platform,
      accountId: third,
      pidScene: 'self_buy',
    });
    expect(await r.authAccountId(appId, platform, null)).toBe(third);
    expect(await r.authAccountId(appId, platform, later)).toBe(later);
    // Another scene's active slot is not a self_buy slot and never decides the account.
    await activeSlot(db, { appId, platform, accountId: later, pidScene: 'agent' });
    await db
      .updateTable('union_pids')
      .set({ status: 'retired' })
      .where('app_id', '=', appId)
      .where('id', '=', slot.id)
      .execute();
    // ③ neither: the earliest-registered account.
    expect(await r.authAccountId(appId, platform, null)).toBe(first);
  },
  60_000,
);
