// B2-07a rule tests (规划/08 BR-WDR-23; 规划/04 §3.2; 编排裁定 D10-408): columns, types, NOT NULL,
// CHECK and unique keys of app.recon_channel and app.payout_recon_runs, on a migrated test database.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CHANNELS,
  FINISHED,
  NEXT_BILL_DATE,
  RESULTS,
  RUN_STATUSES,
  SHAPES,
  STARTED,
  STATUSES,
  TABLES,
  TIMEOUT,
  appId,
  close,
  columns,
  insert,
  line,
  manualLine,
  open,
  ready,
  run,
  sample,
  sqlState,
  stored,
  type Harness,
  type ReconTable,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

interface Index {
  keys: string[];
  unique: boolean;
  valid: boolean;
  ready: boolean;
  predicate: string | null;
}
async function indexes(table: ReconTable): Promise<Index[]> {
  return (
    await sql<Index>`SELECT ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys,
      i.indisunique AS unique, i.indisvalid AS valid, i.indisready AS ready,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i WHERE i.indrelid = to_regclass(${`app.${table}`})`.execute(h.app)
  ).rows;
}

for (const table of TABLES) {
  it(`[BR-WDR-23] ${table} 列名、类型、可空性和默认值逐一匹配，金额列为 bigint 分`, async () => {
    await ready(h.app);
    const found = await columns(h.app, table);
    expect(found.map((c) => c.name).sort()).toEqual(Object.keys(SHAPES[table]).sort());
    for (const [name, [type, nullable, default_expr]] of Object.entries(SHAPES[table])) {
      expect(found, name).toContainEqual({ name, type, nullable, default_expr });
    }
  });

  it(`[BR-WDR-23] ${table} 主键为 id，必填列拒绝 NULL，取值原样写入`, async () => {
    await ready(h.app);
    const row = sample(table, appId());
    for (const [name, [, nullable]] of Object.entries(SHAPES[table])) {
      if (!nullable)
        expect(await sqlState(insert(h.app, table, { ...row, [name]: null })), name).toBe('23502');
    }
    expect(await sqlState(insert(h.app, table, row))).toBe('ok');
    const saved = (await stored(h.app, table, row['id']))[0];
    expect(saved?.['created_at']).toBeInstanceOf(Date);
    expect(saved?.['updated_at']).toBeInstanceOf(Date);
    if (table === 'recon_channel')
      expect(saved).toMatchObject({ our_amount_fen: 10000n, channel_amount_fen: 10000n });
    else expect(saved).toMatchObject({ started_at: STARTED, finished_at: FINISHED });
    const pk = await sql<{ keys: string[] }>`SELECT
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS keys
      FROM pg_constraint c WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'p'`.execute(
      h.app,
    );
    expect(pk.rows).toEqual([{ keys: ['id'] }]);
  });
}

it('[BR-WDR-23] recon_channel 金额整数分超出 2^53 原样往返，不丢精度', async () => {
  await ready(h.app);
  const big = 9_007_199_254_740_993n;
  const row = line(appId(), { our_amount_fen: big, channel_amount_fen: big + 2n, result: 'diff' });
  await insert(h.app, 'recon_channel', row);
  expect((await stored(h.app, 'recon_channel', row['id']))[0]).toMatchObject({
    our_amount_fen: big,
    channel_amount_fen: big + 2n,
  });
});

it('[BR-WDR-23] recon_channel.result 只接受 ①②③ 与一致四种处置结果', async () => {
  await ready(h.app);
  const app = appId();
  for (const result of RESULTS) {
    expect(await sqlState(insert(h.app, 'recon_channel', line(app, { result }))), result).toBe(
      'ok',
    );
  }
  for (const result of ['', 'MATCHED', 'mismatch', 'unknown', 'paying']) {
    expect(await sqlState(insert(h.app, 'recon_channel', line(app, { result }))), result).toBe(
      '23514',
    );
  }
});

it('[BR-WDR-23] recon_channel.our_status 为空（没有对应单）或取提现单状态之一', async () => {
  await ready(h.app);
  const app = appId();
  for (const our_status of [null, ...STATUSES]) {
    const row = line(app, {
      our_status,
      our_amount_fen: our_status === null ? null : 10000n,
      result: our_status === 'PAID_API' ? 'matched' : 'diff',
    });
    expect(await sqlState(insert(h.app, 'recon_channel', row)), String(our_status)).toBe('ok');
  }
  for (const our_status of ['', 'paid_api', 'PAID', 'SUCCESS']) {
    expect(
      await sqlState(insert(h.app, 'recon_channel', line(app, { our_status, result: 'diff' }))),
      our_status,
    ).toBe('23514');
  }
});

it('[BR-WDR-23] recon_channel 两侧可各自缺失：支付宝成功而查无此单、内部已成功而支付宝无记录', async () => {
  await ready(h.app);
  const app = appId();
  const noOrder = line(app, { our_status: null, our_amount_fen: null, result: 'diff' });
  const noBill = line(app, {
    channel_order_id: null,
    channel_status: null,
    channel_amount_fen: null,
    result: 'diff',
  });
  expect(await sqlState(insert(h.app, 'recon_channel', noOrder))).toBe('ok');
  expect(await sqlState(insert(h.app, 'recon_channel', noBill))).toBe('ok');
});

it('[BR-WDR-23] recon_channel 每行至少有 out_biz_no 或 channel_order_id 之一，单号不为空串，金额不为负', async () => {
  await ready(h.app);
  const app = appId();
  expect(
    await sqlState(
      insert(h.app, 'recon_channel', line(app, { out_biz_no: null, channel_order_id: null })),
    ),
  ).toBe('23514');
  expect(await sqlState(insert(h.app, 'recon_channel', line(app, { out_biz_no: '' })))).toBe(
    '23514',
  );
  expect(
    await sqlState(insert(h.app, 'recon_channel', manualLine(app, { channel_order_id: '' }))),
  ).toBe('23514');
  for (const column of ['our_amount_fen', 'channel_amount_fen']) {
    const row = line(app, { [column]: -1n, result: 'diff' });
    expect(await sqlState(insert(h.app, 'recon_channel', row)), column).toBe('23514');
  }
  expect(
    await sqlState(insert(h.app, 'recon_channel', line(app, { out_biz_no: null }))),
    'manual line keyed by channel_order_id',
  ).toBe('ok');
});

it('[BR-WDR-23] recon_channel 接口单按 (app_id, bill_date, out_biz_no) 唯一：次日账单与别的 App 不冲突', async () => {
  await ready(h.app);
  const app = appId();
  const first = line(app);
  await insert(h.app, 'recon_channel', first);
  const same = { out_biz_no: first['out_biz_no'] };
  expect(
    await sqlState(insert(h.app, 'recon_channel', line(app, { ...same, result: 'diff' }))),
  ).toBe('23505');
  expect(
    await sqlState(insert(h.app, 'recon_channel', line(app, { ...same, channel_order_id: null }))),
  ).toBe('23505');
  // paid_at near the day boundary: the same out_biz_no is looked up in the next day's bill too.
  const nextDay = line(app, { ...same, bill_date: NEXT_BILL_DATE });
  expect(await sqlState(insert(h.app, 'recon_channel', nextDay))).toBe('ok');
  expect(await sqlState(insert(h.app, 'recon_channel', line(appId(), same)))).toBe('ok');
});

it('[BR-WDR-23] recon_channel 手动单按 (app_id, bill_date, channel_order_id) 唯一：次日账单与别的 App 不冲突', async () => {
  await ready(h.app);
  const app = appId();
  const first = manualLine(app);
  await insert(h.app, 'recon_channel', first);
  const same = { channel_order_id: first['channel_order_id'] };
  expect(
    await sqlState(insert(h.app, 'recon_channel', manualLine(app, { ...same, result: 'diff' }))),
  ).toBe('23505');
  expect(
    await sqlState(
      insert(h.app, 'recon_channel', manualLine(app, { ...same, bill_date: NEXT_BILL_DATE })),
    ),
  ).toBe('ok');
  expect(await sqlState(insert(h.app, 'recon_channel', manualLine(appId(), same)))).toBe('ok');
  expect(await sqlState(insert(h.app, 'recon_channel', manualLine(app)))).toBe('ok');
});

it('[BR-WDR-23] recon_channel 两个唯一键都是有效的部分唯一索引', async () => {
  await ready(h.app);
  const found = await indexes('recon_channel');
  for (const keys of [
    ['app_id', 'bill_date', 'out_biz_no'],
    ['app_id', 'bill_date', 'channel_order_id'],
  ]) {
    const index = found.find((i) => i.unique && i.keys.join(',') === keys.join(','));
    expect(index, keys.join(',')).toMatchObject({ valid: true, ready: true });
    expect(index?.predicate, keys.join(',')).toBeTypeOf('string');
  }
});

it('[BR-WDR-23] payout_recon_runs.status 只接受 succeeded / partial / failed', async () => {
  await ready(h.app);
  const app = appId();
  for (const [n, status] of RUN_STATUSES.entries()) {
    const bill_date = `2032-06-0${n + 1}`;
    expect(
      await sqlState(insert(h.app, 'payout_recon_runs', run(app, { status, bill_date }))),
      status,
    ).toBe('ok');
  }
  for (const status of ['', 'SUCCEEDED', 'success', 'running', 'diff']) {
    const row = run(app, { status, bill_date: '2032-06-09' });
    expect(await sqlState(insert(h.app, 'payout_recon_runs', row)), status).toBe('23514');
  }
});

it('[BR-WDR-23] payout_recon_runs.channel 现在只接受 alipay（R2 先只做支付宝）', async () => {
  await ready(h.app);
  const app = appId();
  for (const channel of CHANNELS) {
    expect(await sqlState(insert(h.app, 'payout_recon_runs', run(app, { channel }))), channel).toBe(
      'ok',
    );
  }
  for (const channel of ['', 'ALIPAY', 'bank_card', 'wechat', 'wechat_pay']) {
    expect(await sqlState(insert(h.app, 'payout_recon_runs', run(app, { channel }))), channel).toBe(
      '23514',
    );
  }
});

it('[BR-WDR-23] payout_recon_runs 计数不为负，结束时刻不早于开始时刻', async () => {
  await ready(h.app);
  const app = appId();
  for (const column of ['bill_rows', 'matched', 'diffs']) {
    expect(
      await sqlState(
        insert(h.app, 'payout_recon_runs', run(app, { [column]: -1, bill_date: '2032-06-01' })),
      ),
      column,
    ).toBe('23514');
  }
  expect(
    await sqlState(
      insert(
        h.app,
        'payout_recon_runs',
        run(app, { finished_at: new Date(STARTED.getTime() - 1), bill_date: '2032-06-01' }),
      ),
    ),
  ).toBe('23514');
  // A day whose bill could not be fetched: failed, nothing read.
  expect(
    await sqlState(
      insert(
        h.app,
        'payout_recon_runs',
        run(app, {
          status: 'failed',
          finished_at: STARTED,
          bill_rows: 0,
          matched: 0,
          diffs: 0,
          bill_date: '2032-06-01',
        }),
      ),
    ),
  ).toBe('ok');
});

it('[BR-WDR-23] payout_recon_runs 按 (app_id, channel, bill_date) 唯一：每个 App 每天一行', async () => {
  await ready(h.app);
  const app = appId();
  await insert(h.app, 'payout_recon_runs', run(app));
  expect(await sqlState(insert(h.app, 'payout_recon_runs', run(app, { status: 'failed' })))).toBe(
    '23505',
  );
  expect(
    await sqlState(insert(h.app, 'payout_recon_runs', run(app, { bill_date: NEXT_BILL_DATE }))),
  ).toBe('ok');
  expect(await sqlState(insert(h.app, 'payout_recon_runs', run(appId())))).toBe('ok');
  const found = await indexes('payout_recon_runs');
  const key = found.find(
    (i) => i.unique && i.keys.join(',') === 'app_id,channel,bill_date' && i.predicate === null,
  );
  expect(key).toMatchObject({ valid: true, ready: true });
});
