import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  AT,
  CASES,
  HASH,
  FixedClock,
  createInviteRelationHitWriter,
  hits,
  rules,
  seedUser,
} from './kit.ts';

let database: TestDatabase;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

it.each(CASES)(
  '[AC-B1-03x#2] $rule_id 首次命中登记规则并准确写入一行，时间来自 Clock',
  async (entry) => {
    // 工厂在测试体内调用：先红必须是本用例的 NotImplemented，不是 setup 失败。
    const clock = new FixedClock(AT);
    const writer = createInviteRelationHitWriter({ clock });
    const appId = `invite_${randomUUID()}`;
    const userId = await seedUser(db, appId);
    clock.advanceMs(1234);
    const now = clock.now();
    await db.transaction().execute(async (trx) => {
      await writer.record(trx, {
        app_id: appId,
        user_id: userId,
        ...entry,
        value_hmac: HASH,
      });
      const registered = await rules(trx, appId);
      expect(registered).toHaveLength(1);
      expect(registered[0]).toMatchObject({
        app_id: appId,
        rule_id: entry.rule_id,
        scene: 'invite_relation',
        conditions: {},
        risk_action: 'block',
        status: 'active',
        version: 1,
        created_at: now,
        updated_at: now,
      });
      const ruleId = registered[0]!.id;
      expect(ruleId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(Number.parseInt(ruleId.replaceAll('-', '').slice(0, 12), 16)).toBe(now.getTime());
      const recorded = await hits(trx, appId);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        app_id: appId,
        user_id: userId,
        rule_id: entry.rule_id,
        risk_action: 'block',
        dimension: entry.dimension,
        value_hmac: HASH,
        ref_type: 'invite_relation',
        ref_id: userId,
        request_type: null,
        related_phone_hmac: null,
        related_phone_masked: null,
        amount_fen: null,
        created_at: now,
      });
      expect(
        await db.selectFrom('risk_hits').select('id').where('app_id', '=', appId).execute(),
      ).toEqual([]);
      expect(
        await db.selectFrom('risk_rules').select('id').where('app_id', '=', appId).execute(),
      ).toEqual([]);
    });
    expect(await hits(db, appId)).toHaveLength(1);
    expect(await rules(db, appId)).toHaveLength(1);
    expect(
      await db.selectFrom('risk_judgements').selectAll().where('app_id', '=', appId).execute(),
    ).toEqual([]);
  },
);

it('[AC-B1-03x#3] 同 app 同规则再次命中只追加命中，不更新或重复登记已有规则', async () => {
  const clock = new FixedClock(AT);
  const writer = createInviteRelationHitWriter({ clock });
  const appId = `invite_${randomUUID()}`;
  const userId = await seedUser(db, appId);
  const input = { app_id: appId, user_id: userId, ...CASES[0], value_hmac: HASH };
  await db.transaction().execute((trx) => writer.record(trx, input));
  // 已登记规则可能由管理侧配置；重复记录不得将其覆写回初始值。
  await db
    .updateTable('risk_rules')
    .set({
      conditions: { configured: true },
      status: 'inactive',
      version: 7,
    })
    .where('app_id', '=', appId)
    .where('rule_id', '=', input.rule_id)
    .execute();
  const originalRules = await rules(db, appId);
  const originalHits = await hits(db, appId);
  clock.advanceMs(60_000);
  await db.transaction().execute((trx) => writer.record(trx, input));
  expect(await rules(db, appId)).toEqual(originalRules);
  const recorded = await hits(db, appId);
  expect(recorded).toHaveLength(2);
  expect(recorded[0]).toEqual(originalHits[0]);
  expect(recorded[1]).toMatchObject({ ...input, risk_action: 'block', created_at: clock.now() });
  expect(recorded[1]!.id).not.toBe(recorded[0]!.id);
});

it('[AC-B1-03x#4] 两个 app 使用同一规则时各自登记，命中不串应用', async () => {
  const writer = createInviteRelationHitWriter({ clock: new FixedClock(AT) });
  const appIds = [`invite_${randomUUID()}`, `invite_${randomUUID()}`];
  const ids: string[] = [];
  for (const appId of appIds) {
    const userId = await seedUser(db, appId);
    await db.transaction().execute((trx) =>
      writer.record(trx, {
        app_id: appId,
        user_id: userId,
        ...CASES[3],
        value_hmac: HASH,
      }),
    );
    const registered = await rules(db, appId);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ app_id: appId, rule_id: CASES[3].rule_id });
    ids.push(registered[0]!.id);
    const recorded = await hits(db, appId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ app_id: appId, user_id: userId, ref_id: userId });
  }
  expect(new Set(ids).size).toBe(2);
});

it('[AC-B1-03x#5] 调用方回滚后规则和命中均不留行，随后可正常重试', async () => {
  const writer = createInviteRelationHitWriter({ clock: new FixedClock(AT) });
  const appId = `invite_${randomUUID()}`;
  const userId = await seedUser(db, appId);
  const input = { app_id: appId, user_id: userId, ...CASES[3], value_hmac: HASH };
  const rollback = new Error('caller rollback');
  await expect(
    db.transaction().execute(async (trx) => {
      await writer.record(trx, input);
      expect(await hits(trx, appId)).toHaveLength(1);
      expect(await rules(trx, appId)).toHaveLength(1);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await hits(db, appId)).toEqual([]);
  expect(await rules(db, appId)).toEqual([]);
  await db.transaction().execute((trx) => writer.record(trx, input));
  expect(await hits(db, appId)).toHaveLength(1);
  expect(await rules(db, appId)).toHaveLength(1);
});

it('[AC-B1-03x#6] 同 app 同规则并发首次命中，唯一约束只保留一条规则、两条命中', async () => {
  const writer = createInviteRelationHitWriter({ clock: new FixedClock(AT) });
  const appId = `invite_${randomUUID()}`;
  const users = [await seedUser(db, appId), await seedUser(db, appId)];
  await Promise.all(
    users.map((userId) =>
      db.transaction().execute((trx) =>
        writer.record(trx, {
          app_id: appId,
          user_id: userId,
          ...CASES[2],
          value_hmac: HASH,
        }),
      ),
    ),
  );
  expect(await rules(db, appId)).toHaveLength(1);
  const recorded = await hits(db, appId);
  expect(recorded).toHaveLength(2);
  expect(recorded.map((row) => row.user_id).sort()).toEqual([...users].sort());
});
