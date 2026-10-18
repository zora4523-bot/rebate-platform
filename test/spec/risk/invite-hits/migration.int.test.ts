import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AT, HASH, hits, seedUser } from './kit.ts';

let database: TestDatabase;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
}, 180_000);
afterAll(async () => {
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

function requireMigration(): void {
  const files = readdirSync(new URL('../../../../db/migrations/', import.meta.url));
  // 没有迁移时由明确断言先红，不能靠缺文件或 PostgreSQL 异常充当先红。
  expect(files.filter((file) => /^\d{4}_risk-hits-invite-relation\.sql$/.test(file))).toHaveLength(
    1,
  );
}

async function fixture() {
  const appId = `invite_migration_${randomUUID()}`;
  const userId = await seedUser(db, appId);
  await db
    .insertInto('risk_rules')
    .values({
      id: randomUUID(),
      app_id: appId,
      rule_id: 'inv_08_self',
      scene: 'invite_relation',
      conditions: {},
      risk_action: 'block',
      status: 'active',
      version: 1,
      created_at: new Date(AT),
      updated_at: new Date(AT),
    })
    .execute();
  return { appId, userId };
}

it('[AC-B1-03x#7] risk_hits CHECK 接受 invite_relation 和旧值，仍拒绝未知值及 unbind', async () => {
  requireMigration();
  const { appId, userId } = await fixture();
  const base = {
    app_id: appId,
    user_id: userId,
    rule_id: 'inv_08_self',
    risk_action: 'block',
    dimension: 'user_id',
    value_hmac: HASH,
    ref_id: userId,
    created_at: new Date(AT),
  };
  for (const refType of ['invite_relation', 'order', 'withdrawal', 'blocked_request']) {
    await expect(
      db
        .insertInto('risk_hits')
        .values({ ...base, ref_type: refType })
        .execute(),
    ).resolves.toHaveLength(1);
  }
  expect(await hits(db, appId)).toHaveLength(4);
  for (const refType of ['invite_relations', 'unknown', '', 'INVITE_RELATION']) {
    await expect(
      db
        .insertInto('risk_hits')
        .values({ ...base, ref_type: refType })
        .execute(),
    ).rejects.toMatchObject({ code: '23514', constraint: 'risk_hits_ref_type_check' });
  }
  await expect(
    db
      .insertInto('risk_hits')
      .values({
        ...base,
        ref_type: 'invite_relation',
        risk_action: 'unbind',
      })
      .execute(),
  ).rejects.toMatchObject({ code: '23514', constraint: 'risk_hits_risk_action_check' });
  expect(await hits(db, appId)).toHaveLength(4);
});

it('[AC-B1-03x#8] 不放宽 risk_judgements.ref_type 或 risk_rules.risk_action', async () => {
  requireMigration();
  const { appId, userId } = await fixture();
  for (const refType of ['order', 'withdrawal', 'blocked_request']) {
    await expect(
      db
        .insertInto('risk_judgements')
        .values({
          app_id: appId,
          user_id: userId,
          rule_id: 'inv_08_self',
          ref_type: refType,
          ref_id: userId,
          marked: true,
          result: { marked: true },
          judged_at: new Date(AT),
        })
        .execute(),
    ).resolves.toHaveLength(1);
  }
  for (const refType of ['invite_relation', 'unknown']) {
    await expect(
      db
        .insertInto('risk_judgements')
        .values({
          app_id: appId,
          user_id: userId,
          rule_id: 'inv_08_self',
          ref_type: refType,
          ref_id: userId,
          marked: true,
          result: { marked: true },
          judged_at: new Date(AT),
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514', constraint: 'risk_judgements_ref_type_check' });
  }
  await expect(
    sql`INSERT INTO app.risk_rules
    (id, app_id, rule_id, scene, conditions, risk_action, status, version)
    VALUES (${randomUUID()}, ${appId}, 'invalid_action', 'invite_relation', '{}'::jsonb,
      'unbind', 'active', 1)`.execute(db),
  ).rejects.toMatchObject({ code: '23514', constraint: 'risk_rules_risk_action_check' });
});
