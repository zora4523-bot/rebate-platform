import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AMOUNTS,
  EVENTS,
  SPLITS,
  TOTALS,
  TABLES,
  TIMEOUT,
  close,
  fixture,
  insert,
  open,
  ready,
  row,
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

for (const table of [SPLITS, AMOUNTS, TOTALS] as const) {
  it(`[AC-B2-01g#11] ${table} 重放与并发重复写入都被唯一约束拦截`, async () => {
    await ready(h.app);
    const f = await fixture(h.app);
    const valid = row(table, f);
    const results = await Promise.all([
      sqlState(insert(h.app, table, valid)),
      sqlState(insert(h.app, table, valid)),
    ]);
    expect(results.sort()).toEqual(['23505', 'ok']);
    expect(
      await sqlState(
        insert(h.app, table, { ...valid, created_at: new Date('2032-04-02T00:00:00Z') }),
      ),
    ).toBe('23505');
    expect(await stored(h.app, table, f.orderId)).toHaveLength(1);
    const next = await fixture(h.app, f.appId);
    expect(await sqlState(insert(h.app, table, row(table, next)))).toBe('ok');
  });
}

it('[AC-B2-01g#12] 快照唯一键是 order_id，金额和汇总的唯一键包含各自全部规定维度', async () => {
  await ready(h.app);
  for (const [table, keys] of [
    [SPLITS, ['order_id']],
    [AMOUNTS, ['app_id', 'order_id', 'commission_version', 'user_id', 'role']],
    [TOTALS, ['app_id', 'order_id', 'commission_version']],
  ] as const) {
    const indexes = await sql<{ keys: string[] }>`SELECT ARRAY(
      SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
      WHERE k.ord <= i.indnkeyatts ORDER BY k.ord
    ) AS keys FROM pg_index i WHERE i.indrelid = to_regclass(${`app.${table}`})
      AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL`.execute(
      h.app,
    );
    expect(
      indexes.rows.map((index) => index.keys.toSorted()),
      table,
    ).toContainEqual([...keys].sort());
  }
});

it('[AC-B2-01g#13] 金额允许同用户多个角色、其他用户和新版本；历史版本保持原值', async () => {
  await ready(h.app);
  const f = await fixture(h.app);
  const other = await fixture(h.app, f.appId);
  for (const role of ['self', 'share', 'direct', 'indirect']) {
    expect(await sqlState(insert(h.app, AMOUNTS, row(AMOUNTS, f, { role })))).toBe('ok');
  }
  expect(await sqlState(insert(h.app, AMOUNTS, row(AMOUNTS, f, { user_id: other.userId })))).toBe(
    'ok',
  );
  expect(
    await sqlState(
      insert(
        h.app,
        AMOUNTS,
        row(AMOUNTS, f, {
          commission_version: 2,
          base_fen: 600n,
          amount_fen: 300n,
        }),
      ),
    ),
  ).toBe('ok');
  const amounts = await stored(h.app, AMOUNTS, f.orderId);
  expect(amounts).toHaveLength(6);
  expect(amounts).toContainEqual(
    expect.objectContaining({
      commission_version: 1,
      user_id: f.userId,
      role: 'self',
      amount_fen: 425n,
    }),
  );
  expect(amounts).toContainEqual(
    expect.objectContaining({
      commission_version: 2,
      user_id: f.userId,
      role: 'self',
      amount_fen: 300n,
    }),
  );
  for (const commission_version of [1, 2]) {
    expect(await sqlState(insert(h.app, TOTALS, row(TOTALS, f, { commission_version })))).toBe(
      'ok',
    );
  }
  expect(await stored(h.app, TOTALS, f.orderId)).toHaveLength(2);
});

it('[AC-B2-01g#14] 受益人状态只追加，active、held、forfeited 及原因和历史记录可保存', async () => {
  await ready(h.app);
  const f = await fixture(h.app);
  const history = [
    { status: 'active', reason: null, created_at: new Date('2032-04-01T08:00:00Z') },
    { status: 'held', reason: null, created_at: new Date('2032-04-02T08:00:00Z') },
    { status: 'active', reason: null, created_at: new Date('2032-04-03T08:00:00Z') },
    { status: 'forfeited', reason: 'banned', created_at: new Date('2032-04-04T08:00:00Z') },
  ];
  for (const event of history) {
    expect(await sqlState(insert(h.app, EVENTS, row(EVENTS, f, event)))).toBe('ok');
  }
  const events =
    await sql`SELECT status, reason, created_at FROM app.commission_split_beneficiary_events
    WHERE order_id = ${f.orderId} ORDER BY created_at`.execute(h.app);
  expect(events.rows).toEqual(history);
  for (const reason of ['deleted', 'minor']) {
    const next = await fixture(h.app);
    expect(
      await sqlState(insert(h.app, EVENTS, row(EVENTS, next, { status: 'forfeited', reason }))),
    ).toBe('ok');
    expect((await stored(h.app, EVENTS, next.orderId))[0]?.['reason']).toBe(reason);
  }
});

for (const table of TABLES) {
  it(`[AC-B2-01g#15] ${table} 拒绝不存在和跨 app 的订单键`, async () => {
    await ready(h.app);
    const f = await fixture(h.app);
    const foreign = await fixture(h.app);
    for (const order_id of [randomUUID(), foreign.orderId]) {
      expect(await sqlState(insert(h.app, table, row(table, f, { order_id })))).toBe('23503');
    }
    expect(await sqlState(insert(h.app, table, row(table, f)))).toBe('ok');
  });
}

it('[AC-B2-01g#16] 快照规则版本必须存在且属于同 app', async () => {
  await ready(h.app);
  const f = await fixture(h.app);
  const foreign = await fixture(h.app);
  for (const rule_version_id of [randomUUID(), foreign.versionId]) {
    expect(await sqlState(insert(h.app, SPLITS, row(SPLITS, f, { rule_version_id })))).toBe(
      '23503',
    );
  }
  expect(await sqlState(insert(h.app, SPLITS, row(SPLITS, f)))).toBe('ok');
});

it('[AC-B2-01g#17] 外键为完整的同 app 复合引用，不引用分区 orders，不级联更新或删除', async () => {
  await ready(h.app);
  for (const table of TABLES) {
    const fks = await sql<{
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
      FROM pg_constraint c WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'f'`.execute(
      h.app,
    );
    const required = [{ target: 'app.order_keys', keys: ['app_id', 'order_id'] }];
    if (table === SPLITS)
      required.push({
        target: 'app.commission_rule_versions',
        keys: ['app_id', 'rule_version_id'],
      });
    for (const { target, keys } of required) {
      expect(fks.rows, `${table} → ${target}`).toContainEqual(
        expect.objectContaining({
          target,
          source: keys,
          target_columns: keys,
          valid: true,
        }),
      );
    }
    for (const fk of fks.rows) {
      expect(fk.target).not.toBe('app.orders');
      expect(['a', 'r']).toContain(fk.deletion);
      expect(['a', 'r']).toContain(fk.updating);
    }
  }
});
