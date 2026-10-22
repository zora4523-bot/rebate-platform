import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { INDEX, RULE, START, databaseFixture } from './kit.ts';

const database = databaseFixture();

it('[AC-B1-09a#21] BLACKLIST_HIT 部分唯一索引由 PG 兜底；五列分别参与且不影响其他规则', async () => {
  const db = database();
  // 只按对象名核对，不锁定迁移编号。先断言索引存在，未迁移时只产生断言红。
  const index = await sql<{
    unique: boolean;
    predicate: string;
    columns: string[];
  }>`SELECT i.indisunique AS unique, pg_get_expr(i.indpred, i.indrelid) AS predicate,
      ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, pos)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        ORDER BY k.pos) AS columns
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'app.risk_hits'::regclass AND c.relname = ${INDEX}`.execute(db);
  expect(index.rows).toHaveLength(1);
  expect(index.rows[0]!.unique).toBe(true);
  expect(index.rows[0]!.columns).toEqual(['app_id', 'rule_id', 'ref_type', 'ref_id', 'value_hmac']);
  expect(index.rows[0]!.predicate).toMatch(/^\(rule_id = 'BLACKLIST_HIT'::text\)$/u);

  const app = `blacklist_index_${randomUUID()}`;
  const otherApp = `${app}_other`;
  for (const appId of [app, otherApp]) {
    for (const rule of [RULE, 'fixture_non_blacklist']) {
      await db
        .insertInto('risk_rules')
        .values({
          id: randomUUID(),
          app_id: appId,
          rule_id: rule,
          scene: 'order',
          conditions: {},
          risk_action: 'manual_review',
          status: 'active',
          version: 1,
          created_at: START,
          updated_at: START,
        })
        .execute();
    }
  }
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
  await expect(db.insertInto('risk_hits').values(hit).execute()).rejects.toMatchObject({
    code: '23505',
    constraint: INDEX,
  });
  // dimension、risk_action 不在键中，不能通过改变它们绕过去重。
  await expect(
    db
      .insertInto('risk_hits')
      .values({
        ...hit,
        dimension: 'order_no_suffix',
        risk_action: 'void_commission',
      })
      .execute(),
  ).rejects.toMatchObject({ code: '23505', constraint: INDEX });
  for (const overrides of [
    { app_id: otherApp },
    { ref_type: 'withdrawal' },
    { ref_id: randomUUID() },
    { value_hmac: 'b'.repeat(64) },
    { rule_id: 'fixture_non_blacklist' },
    { rule_id: 'fixture_non_blacklist' },
  ]) {
    await expect(
      db
        .insertInto('risk_hits')
        .values({ ...hit, ...overrides })
        .execute(),
    ).resolves.toHaveLength(1);
  }
  expect(
    await db.selectFrom('risk_hits').select('id').where('app_id', 'in', [app, otherApp]).execute(),
  ).toHaveLength(7);
});
