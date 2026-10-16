import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  EFFECTIVE,
  RESERVE,
  RULE,
  TABLES,
  TIMEOUT,
  VERSION,
  close,
  columns,
  insert,
  open,
  requireTables,
  reserveRow,
  ruleRow,
  sqlState,
  version,
  versionRow,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open();
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-01d#1] 三表带 app_id，版本字段集中在 versions，比例使用 smallint', async () => {
  await requireTables(h.app);
  const shapes = {
    [VERSION]: {
      rule_version_id: 'uuid',
      app_id: 'text',
      status: 'text',
      indirect_enabled: 'bool',
    },
    [RULE]: {
      rule_version_id: 'uuid',
      app_id: 'text',
      platform: 'text',
      level: 'text',
      order_type: 'text',
      r_own_bp: 'int2',
      r_direct_bp: 'int2',
      r_indirect_bp: 'int2',
    },
    [RESERVE]: {
      rule_version_id: 'uuid',
      app_id: 'text',
      platform: 'text',
      reserve_bp: 'int2',
    },
  };
  for (const [table, required] of Object.entries(shapes)) {
    const found = await columns(h.app, table);
    for (const [name, type] of Object.entries(required)) {
      expect(found, `${table}.${name}`).toContainEqual({ name, type, nullable: 'NO' });
    }
  }
  const metadata = await columns(h.app, VERSION);
  for (const [name, type] of Object.entries({
    effective_from: 'timestamptz',
    base_version_id: 'uuid',
    drafter_id: 'uuid',
    publisher_id: 'uuid',
    published_at: 'timestamptz',
    revoked_at: 'timestamptz',
    indirect_approver_id: 'uuid',
    indirect_approved_at: 'timestamptz',
  })) {
    expect(metadata, name).toContainEqual(expect.objectContaining({ name, type }));
    for (const table of [RULE, RESERVE]) {
      expect((await columns(h.app, table)).map((c) => c.name)).not.toContain(name);
    }
  }
  for (const table of [RULE, RESERVE]) {
    expect((await columns(h.app, table)).map((c) => c.name)).not.toContain('indirect_enabled');
    expect((await columns(h.app, table)).map((c) => c.name)).not.toContain('status');
  }
  const pk = await sql<{ names: string[] }>`SELECT ARRAY(
    SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord
  ) AS names FROM pg_constraint c WHERE c.conrelid = to_regclass('app.commission_rule_versions')
    AND c.contype = 'p'`.execute(h.app);
  expect(pk.rows).toEqual([{ names: ['rule_version_id'] }]);
});

it('[AC-B2-01d#2] 缺省间推关闭，缺省间推比例为零', async () => {
  await requireTables(h.app);
  const parent = await version(h.app);
  const row = ruleRow(parent);
  delete row['r_indirect_bp'];
  expect(await sqlState(insert(h.app, RULE, row))).toBe('ok');
  const stored = await sql<{ indirect_enabled: boolean; r_indirect_bp: number }>`
    SELECT v.indirect_enabled, r.r_indirect_bp FROM app.commission_rule_versions v
    JOIN app.commission_rules r USING (rule_version_id)
    WHERE v.rule_version_id = ${parent['rule_version_id']}`.execute(h.app);
  expect(stored.rows).toEqual([{ indirect_enabled: false, r_indirect_bp: 0 }]);
});

for (const field of ['r_own_bp', 'r_direct_bp', 'r_indirect_bp']) {
  for (const value of [-1, 0, 8000, 8001]) {
    it(`[AC-B2-01d#3] BR-CALC-05/07 ${field}=${String(value)} 的数据库边界`, async () => {
      await requireTables(h.app);
      const parent = await version(h.app, { indirect_enabled: true });
      const row = ruleRow(parent, {
        r_own_bp: 0,
        r_direct_bp: 0,
        r_indirect_bp: 0,
        [field]: value,
      });
      expect(await sqlState(insert(h.app, RULE, row))).toBe(
        value < 0 || value > 8000 ? '23514' : 'ok',
      );
      if (value === 0 || value === 8000) {
        const stored = await sql<{ value: number }>`SELECT ${sql.ref(field)} AS value
          FROM app.commission_rules WHERE rule_version_id = ${parent['rule_version_id']}`.execute(
          h.app,
        );
        expect(stored.rows).toEqual([{ value }]);
      }
    });
  }
}

for (const value of [-1, 0, 10000, 10001]) {
  it(`[AC-B2-01d#4] BR-CALC-02 reserve_bp=${String(value)} 的数据库边界`, async () => {
    await requireTables(h.app);
    const parent = await version(h.app);
    expect(await sqlState(insert(h.app, RESERVE, reserveRow(parent, { reserve_bp: value })))).toBe(
      value < 0 || value > 10000 ? '23514' : 'ok',
    );
    if (value === 0 || value === 10000) {
      const stored = await sql<{ reserve_bp: number }>`SELECT reserve_bp
        FROM app.commission_rule_reserves WHERE rule_version_id = ${parent['rule_version_id']}`.execute(
        h.app,
      );
      expect(stored.rows).toEqual([{ reserve_bp: value }]);
    }
  });
}

it('[AC-B2-01d#5] 必填维度、状态、开关、比例均拒绝 NULL', async () => {
  await requireTables(h.app);
  const parent = await version(h.app);
  for (const table of TABLES) {
    const required =
      table === VERSION
        ? ['rule_version_id', 'app_id', 'status', 'indirect_enabled']
        : table === RULE
          ? [
              'rule_version_id',
              'app_id',
              'platform',
              'level',
              'order_type',
              'r_own_bp',
              'r_direct_bp',
              'r_indirect_bp',
            ]
          : ['rule_version_id', 'app_id', 'platform', 'reserve_bp'];
    for (const field of required) {
      const row =
        table === VERSION
          ? { ...parent, rule_version_id: randomUUID() }
          : table === RULE
            ? ruleRow(parent)
            : reserveRow(parent);
      expect(
        await sqlState(insert(h.app, table, { ...row, [field]: null })),
        `${table}.${field}`,
      ).toBe('23502');
    }
  }
});

it('[AC-B2-01d#6] BR-CALC-06 全部 18 个组合和三个预留均可插入，各维度独立且禁止重复', async () => {
  await requireTables(h.app);
  const parent = await version(h.app);
  for (const platform of ['taobao', 'jd', 'pdd']) {
    for (const level of ['L1', 'L2', 'L3']) {
      for (const order_type of ['self', 'share']) {
        const row = ruleRow(parent, { platform, level, order_type });
        expect(await sqlState(insert(h.app, RULE, row))).toBe('ok');
        expect(await sqlState(insert(h.app, RULE, { ...row, r_own_bp: 4000 }))).toBe('23505');
      }
    }
    const row = reserveRow(parent, { platform });
    expect(await sqlState(insert(h.app, RESERVE, row))).toBe('ok');
    expect(await sqlState(insert(h.app, RESERVE, { ...row, reserve_bp: 2000 }))).toBe('23505');
  }
  const next = await version(h.app, { app_id: parent['app_id'] });
  expect(await sqlState(insert(h.app, RULE, ruleRow(next)))).toBe('ok');
  expect(await sqlState(insert(h.app, RESERVE, reserveRow(next)))).toBe('ok');
  expect(await sqlState(insert(h.app, VERSION, parent))).toBe('23505');
});

for (const [field, invalid] of [
  ['level', ['', 'L0', 'L4', 'l1', ' L1', 'L1 ']],
  ['order_type', ['', 'other', 'SELF', 'share ', ' self']],
] as const) {
  it(`[AC-B2-01d#7] BR-CALC-06 ${field} 拒绝枚举外取值`, async () => {
    await requireTables(h.app);
    const parent = await version(h.app);
    for (const value of invalid) {
      expect(await sqlState(insert(h.app, RULE, ruleRow(parent, { [field]: value }))), value).toBe(
        '23514',
      );
    }
  });
}

it('[AC-B2-01d#8] 平台外键接受契约平台并拒绝未知值，版本外键拒绝孤儿且不级联', async () => {
  await requireTables(h.app);
  const source = readFileSync(
    new URL('../../../../../contracts/enums/platform.yaml', import.meta.url),
    'utf8',
  );
  const block = /^  platform:\n([\s\S]*?)(?=^  \w+:)/m.exec(source)?.[1] ?? '';
  const platforms = [...block.matchAll(/^      ([a-z][a-z0-9_]*):/gm)].map((match) => match[1]!);
  expect(platforms.length).toBeGreaterThan(0);
  const parent = await version(h.app);
  for (const table of [RULE, RESERVE]) {
    const makeRow = table === RULE ? ruleRow : reserveRow;
    for (const platform of platforms) {
      expect(await sqlState(insert(h.app, table, makeRow(parent, { platform })))).toBe('ok');
    }
    for (const platform of ['', 'unknown_platform', 'TAOBAO', 'taobao ', 'tmall']) {
      expect(await sqlState(insert(h.app, table, makeRow(parent, { platform })))).toBe('23503');
    }
    expect(
      await sqlState(insert(h.app, table, makeRow(parent, { rule_version_id: randomUUID() }))),
    ).toBe('23503');
    const fks = await sql<{
      target: string;
      source: string[];
      deletion: string;
      updating: string;
      valid: boolean;
    }>`
      SELECT c.confrelid::regclass::text AS target,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) k(num)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num) AS source,
        c.confdeltype::text AS deletion, c.confupdtype::text AS updating, c.convalidated AS valid
      FROM pg_constraint c WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'f'`.execute(
      h.app,
    );
    for (const [target, field] of [
      ['app.platforms', 'platform'],
      ['app.commission_rule_versions', 'rule_version_id'],
    ]) {
      const fk = fks.rows.find((row) => row.target === target && row.source.includes(field!));
      expect(fk, `${table} → ${target}`).toBeDefined();
      expect(fk?.valid).toBe(true);
      expect(['a', 'r']).toContain(fk?.deletion);
      expect(['a', 'r']).toContain(fk?.updating);
    }
  }
});

it('[AC-B2-01d#9] status 只接受 draft / published / revoked，published 不得缺 effective_from', async () => {
  await requireTables(h.app);
  for (const status of ['draft', 'published', 'revoked']) {
    const row = await versionRow(h.app, { status });
    expect(await sqlState(insert(h.app, VERSION, row)), status).toBe('ok');
  }
  for (const status of ['', 'active', 'PUBLISHED', 'published ']) {
    const row = await versionRow(h.app, { status });
    expect(await sqlState(insert(h.app, VERSION, row)), status).toBe('23514');
  }
  const row = await versionRow(h.app, { status: 'published', effective_from: null });
  expect(['23502', '23514']).toContain(await sqlState(insert(h.app, VERSION, row)));
  delete row['effective_from'];
  expect(['23502', '23514']).toContain(await sqlState(insert(h.app, VERSION, row)));
});

it('[AC-B2-01d#10] 同 app 已发布生效时点唯一，草稿和撤销不占用，其他 app 可复用', async () => {
  await requireTables(h.app);
  const parent = await version(h.app, { status: 'published' });
  // Same instant with a different timezone representation must still conflict.
  const duplicate = {
    ...parent,
    rule_version_id: randomUUID(),
    effective_from: '2031-12-31T16:00:00Z',
  };
  expect(await sqlState(insert(h.app, VERSION, duplicate))).toBe('23505');
  for (const status of ['draft', 'revoked']) {
    expect(
      await sqlState(
        insert(h.app, VERSION, { ...duplicate, rule_version_id: randomUUID(), status }),
      ),
    ).toBe('ok');
  }
  const otherApp = await versionRow(h.app, { status: 'published' });
  expect(await sqlState(insert(h.app, VERSION, otherApp))).toBe('ok');
  const later = {
    ...duplicate,
    rule_version_id: randomUUID(),
    effective_from: new Date('2032-01-01T00:00:01+08:00'),
  };
  expect(await sqlState(insert(h.app, VERSION, later))).toBe('ok');
  const stored = await sql<{
    effective_from: Date;
  }>`SELECT effective_from FROM app.commission_rule_versions
    WHERE rule_version_id = ${parent['rule_version_id']}`.execute(h.app);
  expect(stored.rows).toEqual([{ effective_from: EFFECTIVE }]);
});

it('[AC-B2-01d#11] 两个草稿同时发布同一时点只能一个成功', async () => {
  await requireTables(h.app);
  const first = await version(h.app);
  const second = await version(h.app, { app_id: first['app_id'] });
  const results = await Promise.all(
    [first, second].map((row) =>
      sqlState(
        sql`
    UPDATE app.commission_rule_versions SET status = 'published'
    WHERE rule_version_id = ${row['rule_version_id']}`.execute(h.app),
      ),
    ),
  );
  expect(results.sort()).toEqual(['23505', 'ok']);
  const published = await sql<{ rule_version_id: string }>`SELECT rule_version_id
    FROM app.commission_rule_versions WHERE app_id = ${first['app_id']} AND status = 'published'`.execute(
    h.app,
  );
  expect(published.rows).toHaveLength(1);
});
