import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { TOTALS, harness, insert, ready, receivable, snapshot, sqlState } from './kit.ts';

const h = harness(createTestDatabase);

it('[AC-B2-04b#15] 日快照精确保留大整数及各项金额，按平台存应收而不合并', async () => {
  await ready(h.app);
  const row = snapshot();
  expect(await sqlState(insert(h.app, 'asset_snapshots', row))).toBe('ok');
  const amounts = [
    { platform: 'jd', union_receivable_fen: 2000n },
    { platform: 'meituan', union_receivable_fen: 3000n },
    { platform: 'pdd', union_receivable_fen: 0n },
    { platform: 'taobao', union_receivable_fen: 9007199254740993n },
  ];
  for (const amount of amounts) {
    expect(
      await sqlState(insert(h.app, 'asset_snapshot_receivables', receivable(row, amount))),
    ).toBe('ok');
  }
  const stored = await sql`SELECT snapshot_date::text AS day, total_available_positive_fen,
    total_negative_fen, total_frozen_fen, total_waiting_fen, total_estimated_fen,
    waiting_comparable FROM app.asset_snapshots
    WHERE app_id = ${row['app_id']}`.execute(h.app);
  expect(stored.rows).toEqual([
    {
      day: '2032-06-30',
      total_available_positive_fen: 9007199254740993n,
      total_negative_fen: 400n,
      total_frozen_fen: 100n,
      total_waiting_fen: 925n,
      total_estimated_fen: 123n,
      waiting_comparable: true,
    },
  ]);
  const children = await sql`SELECT platform, union_receivable_fen
    FROM app.asset_snapshot_receivables WHERE asset_snapshot_id = ${row['id']}
      AND app_id = ${row['app_id']} ORDER BY platform`.execute(h.app);
  expect(children.rows).toEqual(amounts);
});

it('[AC-B2-04b#16] 同 app 同日只有一张快照，跨 app、相邻日不冲突', async () => {
  await ready(h.app);
  const row = snapshot();
  expect(await sqlState(insert(h.app, 'asset_snapshots', row))).toBe('ok');
  expect(await sqlState(insert(h.app, 'asset_snapshots', { ...row, id: randomUUID() }))).toBe(
    '23505',
  );
  for (const change of [{ app_id: `other-${randomUUID()}` }, { snapshot_date: '2032-07-01' }]) {
    expect(
      await sqlState(insert(h.app, 'asset_snapshots', { ...row, ...change, id: randomUUID() })),
    ).toBe('ok');
  }
});

it('[AC-B2-04b#17] 并发快照只保留一行，不依赖应用先查后插', async () => {
  await ready(h.app);
  const row = snapshot();
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      sqlState(
        insert(h.app, 'asset_snapshots', {
          ...row,
          id: randomUUID(),
        }),
      ),
    ),
  );
  expect(results.sort()).toEqual(['23505', '23505', 'ok']);
  const stored = await sql`SELECT count(*) AS n FROM app.asset_snapshots
    WHERE app_id = ${row['app_id']} AND snapshot_date = ${row['snapshot_date']}::date`.execute(
    h.app,
  );
  expect(stored.rows).toEqual([{ n: 1n }]);
});

it('[AC-B2-04b#18] 超时快照能标记不可比，余额金额及其他日期不被改动', async () => {
  await ready(h.app);
  const row = snapshot();
  for (const day of ['2032-06-30', '2032-07-01']) {
    expect(
      await sqlState(
        insert(h.app, 'asset_snapshots', { ...row, id: randomUUID(), snapshot_date: day }),
      ),
    ).toBe('ok');
  }
  expect(
    await sqlState(
      sql`UPDATE app.asset_snapshots SET waiting_comparable = false
    WHERE app_id = ${row['app_id']} AND snapshot_date = DATE '2032-06-30'`.execute(h.app),
    ),
  ).toBe('ok');
  const stored = await sql`SELECT snapshot_date::text AS day, waiting_comparable,
    total_available_positive_fen, total_negative_fen, total_frozen_fen
    FROM app.asset_snapshots WHERE app_id = ${row['app_id']} ORDER BY snapshot_date`.execute(h.app);
  expect(stored.rows).toEqual([
    {
      day: '2032-06-30',
      waiting_comparable: false,
      total_available_positive_fen: 9007199254740993n,
      total_negative_fen: 400n,
      total_frozen_fen: 100n,
    },
    {
      day: '2032-07-01',
      waiting_comparable: true,
      total_available_positive_fen: 9007199254740993n,
      total_negative_fen: 400n,
      total_frozen_fen: 100n,
    },
  ]);
  // 也能直接补写超时日，不要求先写一张“可比”的快照。
  expect(
    await sqlState(insert(h.app, 'asset_snapshots', snapshot({ waiting_comparable: false }))),
  ).toBe('ok');
});

it('[AC-B2-04b#19] 显式 D 日不受会话时区影响，日期和各金额不能为 NULL', async () => {
  await ready(h.app);
  const row = snapshot();
  await h.app.transaction().execute(async (trx) => {
    await sql`SET LOCAL TIME ZONE 'America/Los_Angeles'`.execute(trx);
    expect(await sqlState(insert(trx, 'asset_snapshots', row))).toBe('ok');
    const stored = await sql`SELECT snapshot_date::text AS day FROM app.asset_snapshots
      WHERE app_id = ${row['app_id']}`.execute(trx);
    expect(stored.rows).toEqual([{ day: '2032-06-30' }]);
  });
  for (const field of ['app_id', 'snapshot_date', 'waiting_comparable', ...TOTALS]) {
    expect(
      await sqlState(insert(h.app, 'asset_snapshots', snapshot({ [field]: null }))),
      field,
    ).toBe('23502');
  }
  const omitted = snapshot();
  delete omitted['snapshot_date'];
  expect(await sqlState(insert(h.app, 'asset_snapshots', omitted))).toBe('23502');
});

it('[AC-B2-04b#20] 应收子表按快照和平台唯一，必填列不空且必须关联已有快照', async () => {
  await ready(h.app);
  const parent = snapshot();
  expect(await sqlState(insert(h.app, 'asset_snapshots', parent))).toBe('ok');
  const row = receivable(parent);
  expect(await sqlState(insert(h.app, 'asset_snapshot_receivables', row))).toBe('ok');
  expect(
    await sqlState(
      insert(h.app, 'asset_snapshot_receivables', { ...row, union_receivable_fen: 1n }),
    ),
  ).toBe('23505');
  expect(
    await sqlState(insert(h.app, 'asset_snapshot_receivables', { ...row, platform: 'jd' })),
  ).toBe('ok');
  const next = snapshot({ app_id: parent['app_id'], snapshot_date: '2032-07-01' });
  expect(await sqlState(insert(h.app, 'asset_snapshots', next))).toBe('ok');
  expect(await sqlState(insert(h.app, 'asset_snapshot_receivables', receivable(next)))).toBe('ok');
  for (const field of ['asset_snapshot_id', 'app_id', 'platform', 'union_receivable_fen']) {
    expect(
      await sqlState(
        insert(h.app, 'asset_snapshot_receivables', receivable(parent, { [field]: null })),
      ),
      field,
    ).toBe('23502');
  }
  expect(
    await sqlState(
      insert(
        h.app,
        'asset_snapshot_receivables',
        receivable(parent, { asset_snapshot_id: randomUUID() }),
      ),
    ),
  ).toBe('23503');
  const stored = await sql`SELECT platform, union_receivable_fen
    FROM app.asset_snapshot_receivables WHERE asset_snapshot_id = ${parent['id']}
    ORDER BY platform`.execute(h.app);
  expect(stored.rows).toEqual([
    { platform: 'jd', union_receivable_fen: 9007199254740993n },
    { platform: 'taobao', union_receivable_fen: 9007199254740993n },
  ]);
});
