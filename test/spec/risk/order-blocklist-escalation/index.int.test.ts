import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  INDEX,
  RULE,
  SAME_DEVICE,
  SAME_DEVICE_INDEX,
  START,
  databaseFixture,
  expectEscalationIndex,
  indexShape,
  seedRules,
} from './kit.ts';

const database = databaseFixture();
const OTHER_RULE = 'fixture_non_blacklist';

it('[AC-B1-09ab#1] 同名唯一索引按六列重建、谓词只限 BLACKLIST_HIT；无旧五列残留，同设备索引不变', async () => {
  const db = database();
  await expectEscalationIndex(db);
  // 旧五列键若以别的名字留下，改判作废仍会被它拦掉。
  const blacklist = await sql<{ name: string }>`SELECT c.relname::text AS name
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'app.risk_hits'::regclass AND i.indisunique
      AND pg_get_expr(i.indpred, i.indrelid) LIKE '%BLACKLIST_HIT%'
    ORDER BY 1`.execute(db);
  expect(blacklist.rows).toEqual([{ name: INDEX }]);
  expect(await indexShape(db, SAME_DEVICE_INDEX)).toEqual([
    {
      is_unique: true,
      is_valid: true,
      predicate: `(rule_id = '${SAME_DEVICE}'::text)`,
      columns: ['app_id', 'rule_id', 'ref_type', 'ref_id', 'value_hmac'],
    },
  ]);
});

it('[AC-B1-09ab#2] PG 兜底：同一订单同值两种处置各一行，同处置再插按索引名拒绝；dimension 不是去重键', async () => {
  const db = database();
  await expectEscalationIndex(db);
  const app = `blacklist_escalation_${randomUUID()}`;
  const otherApp = `${app}_other`;
  for (const appId of [app, otherApp]) await seedRules(db, appId, [RULE]);
  const hit = {
    app_id: app,
    rule_id: RULE,
    dimension: 'channel',
    value_hmac: 'a'.repeat(64),
    ref_type: 'order',
    ref_id: randomUUID(),
    risk_action: 'manual_review',
    created_at: START,
  };
  await db.insertInto('risk_hits').values(hit).execute();
  await expect(
    db
      .insertInto('risk_hits')
      .values({ ...hit, risk_action: 'void_commission' })
      .execute(),
  ).resolves.toHaveLength(1);
  for (const risk_action of ['manual_review', 'void_commission']) {
    for (const dimension of ['channel', 'order_no_suffix']) {
      await expect(
        db
          .insertInto('risk_hits')
          .values({ ...hit, risk_action, dimension })
          .execute(),
      ).rejects.toMatchObject({ code: '23505', constraint: INDEX });
    }
  }
  // 处置之外的四个键列照旧区分订单与名单值。
  for (const overrides of [
    { app_id: otherApp },
    { ref_type: 'withdrawal' },
    { ref_id: randomUUID() },
    { value_hmac: 'b'.repeat(64) },
  ]) {
    await expect(
      db
        .insertInto('risk_hits')
        .values({ ...hit, ...overrides, risk_action: 'void_commission' })
        .execute(),
    ).resolves.toHaveLength(1);
  }
  const rows = await db
    .selectFrom('risk_hits')
    .select(['app_id', 'risk_action'])
    .where('app_id', 'in', [app, otherApp])
    .where('ref_id', '=', hit.ref_id)
    .where('value_hmac', '=', hit.value_hmac)
    .where('ref_type', '=', 'order')
    .orderBy('id')
    .execute();
  expect(rows).toEqual([
    { app_id: app, risk_action: 'manual_review' },
    { app_id: app, risk_action: 'void_commission' },
    { app_id: otherApp, risk_action: 'void_commission' },
  ]);
});

it.each(['manual_review', 'void_commission', 'block'])(
  '[AC-B1-09ab#3] 其他规则去重不放宽：SAME_DEVICE_MULTI_ACCOUNT 同键换处置 %s 仍被原索引拒绝，无索引规则照旧不去重',
  async (risk_action) => {
    const db = database();
    await expectEscalationIndex(db);
    const app = `blacklist_escalation_${randomUUID()}`;
    await seedRules(db, app, [SAME_DEVICE, OTHER_RULE]);
    const hit = {
      app_id: app,
      rule_id: SAME_DEVICE,
      dimension: 'device',
      value_hmac: 'c'.repeat(64),
      ref_type: 'withdrawal',
      ref_id: randomUUID(),
      risk_action: 'pass',
      created_at: START,
    };
    await db.insertInto('risk_hits').values(hit).execute();
    await expect(
      db
        .insertInto('risk_hits')
        .values({ ...hit, risk_action })
        .execute(),
    ).rejects.toMatchObject({ code: '23505', constraint: SAME_DEVICE_INDEX });
    const other = { ...hit, rule_id: OTHER_RULE, risk_action };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(db.insertInto('risk_hits').values(other).execute()).resolves.toHaveLength(1);
    }
    const rows = await db
      .selectFrom('risk_hits')
      .select(['rule_id', 'risk_action'])
      .where('app_id', '=', app)
      .orderBy('id')
      .execute();
    expect(rows).toEqual([
      { rule_id: SAME_DEVICE, risk_action: 'pass' },
      { rule_id: OTHER_RULE, risk_action },
      { rule_id: OTHER_RULE, risk_action },
    ]);
  },
);

it('[AC-B1-09ab#4] couli_app 对 risk_hits 仍只有 SELECT / INSERT：无表级或列级 UPDATE，无 DELETE，改写首行被拒', async () => {
  const db = database();
  await expectEscalationIndex(db);
  const grants = await sql<Record<string, boolean>>`SELECT
      has_table_privilege('couli_app', 'app.risk_hits', 'SELECT') AS can_select,
      has_any_column_privilege('couli_app', 'app.risk_hits', 'INSERT') AS can_insert,
      has_table_privilege('couli_app', 'app.risk_hits', 'UPDATE') AS can_update,
      has_any_column_privilege('couli_app', 'app.risk_hits', 'UPDATE') AS can_update_column,
      has_table_privilege('couli_app', 'app.risk_hits', 'DELETE') AS can_delete,
      has_table_privilege('couli_app', 'app.risk_hits', 'TRUNCATE') AS can_truncate`.execute(db);
  expect(grants.rows).toEqual([
    {
      can_select: true,
      can_insert: true,
      can_update: false,
      can_update_column: false,
      can_delete: false,
      can_truncate: false,
    },
  ]);
  const app = `blacklist_escalation_${randomUUID()}`;
  await seedRules(db, app, [RULE]);
  await db
    .insertInto('risk_hits')
    .values({
      app_id: app,
      rule_id: RULE,
      dimension: 'channel',
      value_hmac: 'd'.repeat(64),
      ref_type: 'order',
      ref_id: randomUUID(),
      risk_action: 'manual_review',
      created_at: START,
    })
    .execute();
  const read = () => db.selectFrom('risk_hits').selectAll().where('app_id', '=', app).execute();
  const before = await read();
  expect(before).toHaveLength(1);
  await expect(
    sql`UPDATE app.risk_hits SET risk_action = 'void_commission'
      WHERE app_id = ${app}`.execute(db),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    sql`DELETE FROM app.risk_hits
      WHERE app_id = ${app}`.execute(db),
  ).rejects.toMatchObject({ code: '42501' });
  expect(await read()).toEqual(before);
});
