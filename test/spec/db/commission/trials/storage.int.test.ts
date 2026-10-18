import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  SHAPE,
  TIMEOUT,
  close,
  columns,
  fixture,
  insert,
  open,
  ready,
  sqlState,
  stored,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-03o#1] 试算报告字段类型与必填性符合存储约定，只有基准版本可空', async () => {
  await ready(h.app);
  const found = await columns(h.app);
  for (const [name, type] of Object.entries(SHAPE)) {
    expect(found, name).toContainEqual(
      expect.objectContaining({
        name,
        type,
        nullable: name === 'base_version_id',
      }),
    );
  }
});

it('[AC-B2-03o#2] 必填字段逐列拒绝 NULL', async () => {
  await ready(h.app);
  const row = await fixture(h.app);
  for (const name of Object.keys(SHAPE).filter((name) => name !== 'base_version_id')) {
    expect(await sqlState(insert(h.app, { ...row, [name]: null })), name).toBe('23502');
  }
});

it('[AC-B2-03o#3] BR-CALC-22 保存版本、七天窗口、摘要、申请人和完整 JSON 报告', async () => {
  await ready(h.app);
  const row = await fixture(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  expect(await stored(h.app, row['trial_id'])).toEqual([
    expect.objectContaining({ ...row, report: JSON.parse(String(row['report'])) as unknown }),
  ]);
});

it('[AC-B2-03o#4] 无现行版本时允许 NULL 或省略 base_version_id，零样本可保存', async () => {
  await ready(h.app);
  const row = await fixture(h.app);
  for (const omit of [false, true]) {
    const trial = { ...row, trial_id: randomUUID(), sample_count: 0, base_version_id: null };
    const values: Record<string, unknown> = { ...trial };
    if (omit) delete values['base_version_id'];
    expect(await sqlState(insert(h.app, values))).toBe('ok');
    expect(await stored(h.app, trial.trial_id)).toEqual([
      expect.objectContaining({ base_version_id: null, sample_count: 0 }),
    ]);
  }
});

it('[AC-B2-03o#5] 样本窗口拒绝相等或倒置，时间按同一瞬间比较', async () => {
  await ready(h.app);
  const row = await fixture(h.app);
  for (const sample_from of ['2032-06-15T02:00:00Z', '2032-06-15T10:00:01+08:00']) {
    expect(await sqlState(insert(h.app, { ...row, sample_from })), sample_from).toBe('23514');
  }
  expect(await sqlState(insert(h.app, row))).toBe('ok');
});

it('[AC-B2-03o#6] 样本数拒绝负一，接受零与正数', async () => {
  await ready(h.app);
  const row = await fixture(h.app);
  for (const sample_count of [-1, 0, 1]) {
    expect(await sqlState(insert(h.app, { ...row, trial_id: randomUUID(), sample_count }))).toBe(
      sample_count < 0 ? '23514' : 'ok',
    );
  }
});

it('[AC-B2-03o#7] created_at 无默认值，遗漏被拒绝，应用时刻原样保存', async () => {
  await ready(h.app);
  expect(await columns(h.app)).toContainEqual(
    expect.objectContaining({
      name: 'created_at',
      nullable: false,
      default_expr: null,
    }),
  );
  const row = await fixture(h.app);
  const omitted = { ...row };
  delete omitted['created_at'];
  expect(await sqlState(insert(h.app, omitted))).toBe('23502');
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  expect((await stored(h.app, row['trial_id']))[0]?.['created_at']).toEqual(row['created_at']);
});

for (const field of ['rule_version_id', 'base_version_id'] as const) {
  it(`[AC-B2-03o#8] ${field} 拒绝不存在或跨 app 的版本`, async () => {
    await ready(h.app);
    const row = await fixture(h.app);
    const foreign = await fixture(h.app);
    for (const value of [randomUUID(), foreign[field]]) {
      expect(await sqlState(insert(h.app, { ...row, [field]: value })), field).toBe('23503');
    }
    expect(await sqlState(insert(h.app, row))).toBe('ok');
  });
}

it('[AC-B2-03o#9] 两个版本外键均包含 app_id、已验证且禁止级联', async () => {
  await ready(h.app);
  const found = await sql<{
    source: string[];
    target: string;
    target_columns: string[];
    deletion: string;
    updating: string;
    valid: boolean;
  }>`SELECT
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS source,
      c.confrelid::regclass::text AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target_columns,
      c.confdeltype::text AS deletion, c.confupdtype::text AS updating, c.convalidated AS valid
    FROM pg_constraint c WHERE c.conrelid = to_regclass('app.commission_rule_trials')
      AND c.contype = 'f'`.execute(h.app);
  for (const field of ['rule_version_id', 'base_version_id']) {
    const fk = found.rows.find((row) => row.source.join(',') === `app_id,${field}`);
    expect(fk, field).toMatchObject({
      target: 'app.commission_rule_versions',
      target_columns: ['app_id', 'rule_version_id'],
      valid: true,
    });
    expect(['a', 'r']).toContain(fk?.deletion);
    expect(['a', 'r']).toContain(fk?.updating);
  }
});

it('[AC-B2-03o#10] trial_id 是唯一主键，同一版本同一时刻可追加多份报告', async () => {
  await ready(h.app);
  const pk = await sql<{ names: string[] }>`SELECT ARRAY(
      SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord
    ) AS names FROM pg_constraint c
    WHERE c.conrelid = to_regclass('app.commission_rule_trials') AND c.contype = 'p'`.execute(
    h.app,
  );
  expect(pk.rows).toEqual([{ names: ['trial_id'] }]);
  const row = await fixture(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  expect(await sqlState(insert(h.app, row))).toBe('23505');
  const otherApp = await fixture(h.app);
  expect(await sqlState(insert(h.app, { ...otherApp, trial_id: row['trial_id'] }))).toBe('23505');
  const next = { ...row, trial_id: randomUUID() };
  expect(await sqlState(insert(h.app, next))).toBe('ok');
  expect(await stored(h.app, row['trial_id'])).toHaveLength(1);
  expect(await stored(h.app, next.trial_id)).toHaveLength(1);
});

it('[AC-B2-03o#11] 版本历史索引按 app、规则版本、创建时间排列且覆盖全部报告', async () => {
  await ready(h.app);
  const result = await sql<{
    names: string[];
    valid: boolean;
    ready: boolean;
    partial: boolean;
    method: string;
  }>`SELECT ARRAY(
      SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
      WHERE k.ord <= i.indnkeyatts ORDER BY k.ord
    ) AS names, i.indisvalid AS valid, i.indisready AS ready,
    i.indpred IS NOT NULL AS partial, am.amname AS method
    FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_am am ON am.oid = idx.relam
    WHERE i.indrelid = to_regclass('app.commission_rule_trials') AND NOT i.indisprimary`.execute(
    h.app,
  );
  expect(result.rows).toContainEqual({
    names: ['app_id', 'rule_version_id', 'created_at'],
    valid: true,
    ready: true,
    partial: false,
    method: 'btree',
  });
});
