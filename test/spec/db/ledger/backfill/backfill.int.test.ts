import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { account, balance, expectZeroAccount, migration, replay, snapshot, user } from './kit.ts';

async function scenario(
  run: (db: Kysely<DB>, apply: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const source = migration();
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  try {
    // Task §10: couli_app can execute this INSERT-only backfill in a transaction.
    await run(db, () => replay(db, source));
  } finally {
    try {
      await destroyDb(db);
    } finally {
      await database.drop();
    }
  }
}

it('[AC-B2-02h#3] 存量正常、注销中、已注销用户各补一个 USER_BALANCE 账户和零余额', async () => {
  await scenario(async (db, apply) => {
    const appId = `backfill-${randomUUID()}`;
    const ids = [];
    for (const status of ['normal', 'deleting', 'deleted']) {
      ids.push(await user(db, appId, status));
    }
    const before = await snapshot(db, [appId]);
    expect(before.accounts).toEqual([]);
    expect(before.balances).toEqual([]);
    await apply();
    for (const id of ids) await expectZeroAccount(db, appId, id);
    const after = await snapshot(db, [appId]);
    expect(after.accounts).toHaveLength(ids.length);
    expect(after.balances).toHaveLength(ids.length);
    expect(after.users).toEqual(before.users);
  });
});

it('[AC-B2-02h#4] 已并号用户和目标用户各自获得账户，不因并号被跳过或共用账户', async () => {
  await scenario(async (db, apply) => {
    const appId = `backfill-merged-${randomUUID()}`;
    const target = await user(db, appId);
    const source = await user(db, appId, 'deleted', 'merged');
    // schema.sql: merged_into_user_id belongs to device_registrations, not users.
    await db
      .insertInto('device_registrations')
      .values({
        app_id: appId,
        device_hash: randomUUID(),
        user_id: source,
        register_method: 'sms',
        created_at: new Date('2025-01-02T03:04:05.000Z'),
      })
      .execute();
    await db
      .updateTable('device_registrations')
      .set({ merged_into_user_id: target })
      .where('app_id', '=', appId)
      .where('user_id', '=', source)
      .execute();
    const before = await snapshot(db, [appId]);
    const registrations = await db
      .selectFrom('device_registrations')
      .selectAll()
      .where('app_id', '=', appId)
      .execute();
    await apply();
    const sourceAccount = await expectZeroAccount(db, appId, source);
    const targetAccount = await expectZeroAccount(db, appId, target);
    expect(sourceAccount.id).not.toBe(targetAccount.id);
    const after = await snapshot(db, [appId]);
    expect(after.accounts).toHaveLength(2);
    expect(after.balances).toHaveLength(2);
    expect(after.users).toEqual(before.users);
    expect(
      await db.selectFrom('device_registrations').selectAll().where('app_id', '=', appId).execute(),
    ).toEqual(registrations);
  });
});

it('[AC-B2-02h#5] 已有账户及非零余额完整保留，包括负余额日期、冻结余额和版本', async () => {
  await scenario(async (db, apply) => {
    const appId = `backfill-existing-${randomUUID()}`;
    const uid = await user(db, appId);
    const id = await account(db, appId, uid);
    await balance(db, appId, id);
    const before = await snapshot(db, [appId]);
    expect(before.accounts).toHaveLength(1);
    expect(before.balances).toHaveLength(1);
    expect(before.balances[0]).toMatchObject({
      available_fen: -12345n,
      frozen_fen: 6789n,
      version: 17n,
    });
    await apply();
    expect(await snapshot(db, [appId])).toEqual(before);
  });
});

it('[AC-B2-02h#6] 已有账户缺余额行时补零余额，保留原账户 id 和创建时间', async () => {
  await scenario(async (db, apply) => {
    const appId = `backfill-missing-balance-${randomUUID()}`;
    const uid = await user(db, appId);
    const id = await account(db, appId, uid);
    const before = await snapshot(db, [appId]);
    expect(before.accounts).toHaveLength(1);
    expect(before.balances).toEqual([]);
    await apply();
    expect((await expectZeroAccount(db, appId, uid)).id).toBe(id);
    const after = await snapshot(db, [appId]);
    expect(after.accounts).toEqual(before.accounts);
    expect(after.users).toEqual(before.users);
    expect(after.balances).toHaveLength(1);
  });
});

it('[AC-B2-02h#7] 混合存量数据连续重跑两次，与第一次执行后的完整结果一致', async () => {
  await scenario(async (db, apply) => {
    const appId = `backfill-rerun-${randomUUID()}`;
    const missing = await user(db, appId);
    const partial = await user(db, appId);
    const existing = await user(db, appId);
    await account(db, appId, partial);
    await balance(db, appId, await account(db, appId, existing));
    const before = await snapshot(db, [appId]);
    await apply();
    await expectZeroAccount(db, appId, missing);
    await expectZeroAccount(db, appId, partial);
    const once = await snapshot(db, [appId]);
    expect(once.accounts).toHaveLength(3);
    expect(once.balances).toHaveLength(3);
    expect(once.balances).toEqual(expect.arrayContaining(before.balances));
    expect(once.users).toEqual(before.users);
    await apply();
    expect(await snapshot(db, [appId])).toEqual(once);
    await apply();
    expect(await snapshot(db, [appId])).toEqual(once);
  });
});

it('[AC-B2-02h#8] 无用户的 app 不产生行，平台账户及其已有或缺失余额保持原样', async () => {
  await scenario(async (db, apply) => {
    const emptyApp = `backfill-empty-${randomUUID()}`;
    const platformApp = `backfill-platform-${randomUUID()}`;
    // app_id is text, with no apps parent table: absence is represented by an unused id.
    expect(await snapshot(db, [emptyApp])).toEqual({ users: [], accounts: [], balances: [] });
    await account(db, platformApp, 'platform', 'UNION_RECEIVABLE:taobao');
    await balance(
      db,
      platformApp,
      await account(db, platformApp, 'platform', 'COMMISSION_EXPENSE'),
    );
    const before = await snapshot(db, [platformApp]);
    expect(before.users).toEqual([]);
    await apply();
    expect(await snapshot(db, [emptyApp])).toEqual({ users: [], accounts: [], balances: [] });
    expect(await snapshot(db, [platformApp])).toEqual(before);
  });
});

it('[AC-B2-02h#9] 多 app 按 users.app_id 开户，另一 app 的相同 owner_id 不阻挡或接收回填', async () => {
  await scenario(async (db, apply) => {
    const a = `backfill-a-${randomUUID()}`;
    const b = `backfill-b-${randomUUID()}`;
    const uidA = await user(db, a);
    const uidB = await user(db, b);
    // users.id is globally unique. A foreign-app account with the same owner_id is legal
    // and catches joins/NOT EXISTS that forget app_id, without forging duplicate user PKs.
    const decoy = await account(db, b, uidA);
    await balance(db, b, decoy);
    const before = await snapshot(db, [a, b]);
    await apply();
    const accountA = await expectZeroAccount(db, a, uidA);
    const accountB = await expectZeroAccount(db, b, uidB);
    expect(accountA.id).not.toBe(decoy);
    expect(accountB.id).not.toBe(accountA.id);
    const after = await snapshot(db, [a, b]);
    expect(after.accounts).toHaveLength(3);
    expect(after.balances).toHaveLength(3);
    expect(after.accounts).toEqual(expect.arrayContaining(before.accounts));
    expect(after.balances).toEqual(expect.arrayContaining(before.balances));
    expect(after.users).toEqual(before.users);
    expect(
      (
        await sql`SELECT 1 FROM app.ledger_accounts
      WHERE app_id = ${a} AND owner_id = ${uidB}`.execute(db)
      ).rows,
    ).toEqual([]);
  });
});
