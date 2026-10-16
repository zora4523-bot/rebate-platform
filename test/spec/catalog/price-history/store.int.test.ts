// B1-17b: price_snapshot on a real PostgreSQL as couli_app (BR-WATCH-05 (2): advisory lock, latest
// row, insert or update; BR-WATCH-19 (1) examples and no user identifiers; orchestrator semantics
// B.3, B.4). Table app.price_snapshot comes from the merged B1-17a migration (db/schema.sql).
// Every test calls the catalog API before any fixture SQL, so on the skeleton it fails with
// NotImplemented, never with a missing table.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createKyselyPriceSnapshotStore,
  createPriceSnapshotRecorder,
  priceSnapshotLockKey,
  type PriceObservation,
  type PriceSnapshotStore,
  type PriceSnapshotValues,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { at, intervalConfig, observation, storeWrite, vals } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
}, 60_000);
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
}, 60_000);

const COLUMNS = [
  'app_id',
  'coupon_fen',
  'created_at',
  'final_price_fen',
  'first_observed_at',
  'goods_sign_plan',
  'id',
  'in_stock',
  'last_observed_at',
  'observation_count',
  'platform',
  'price_fen',
  'product_key',
  'sku_key',
  'source_kind',
];

type Row = Record<string, unknown>;

async function rows(appId: string): Promise<Row[]> {
  const result = await sql<Row>`
    SELECT * FROM app.price_snapshot WHERE app_id = ${appId}
    ORDER BY product_key, source_kind, first_observed_at, id
  `.execute(db);
  return result.rows;
}

/** The run columns of a row, for compact expectations. */
function runOf(row: Row) {
  return {
    product_key: row['product_key'],
    source_kind: row['source_kind'],
    price_fen: row['price_fen'],
    coupon_fen: row['coupon_fen'],
    final_price_fen: row['final_price_fen'],
    in_stock: row['in_stock'],
    first_observed_at: row['first_observed_at'],
    last_observed_at: row['last_observed_at'],
    observation_count: row['observation_count'],
  };
}

function recorderOn(
  store: PriceSnapshotStore,
  clock: FixedClock,
  config = intervalConfig(undefined),
) {
  const warn = vi.fn();
  const recorder = createPriceSnapshotRecorder({ store, clock, config, logger: { warn } });
  return { recorder, warn };
}

async function observeAt(
  recorder: ReturnType<typeof recorderOn>['recorder'],
  clock: FixedClock,
  instant: Date,
  obs: PriceObservation,
): Promise<void> {
  clock.set(instant);
  recorder.record(obs);
  await recorder.drain();
}

async function insertRun(
  executor: Kysely<DB>,
  appId: string,
  productKey: string,
  fen: bigint,
  instant: Date,
): Promise<void> {
  await sql`
    INSERT INTO app.price_snapshot (app_id, platform, product_key, sku_key, source_kind, price_fen,
      coupon_fen, final_price_fen, in_stock, goods_sign_plan, first_observed_at, last_observed_at,
      observation_count)
    VALUES (${appId}, 'taobao', ${productKey}, NULL, 'detail', ${fen.toString()}::bigint, 0,
      ${fen.toString()}::bigint, true, NULL, ${instant}, ${instant}, 1)
  `.execute(executor);
}

/** A fixture row with explicit run values (the id comes from the identity sequence). */
async function insertRow(
  executor: Kysely<DB>,
  appId: string,
  productKey: string,
  values: PriceSnapshotValues,
  instant: Date,
): Promise<void> {
  await sql`
    INSERT INTO app.price_snapshot (app_id, platform, product_key, sku_key, source_kind, price_fen,
      coupon_fen, final_price_fen, in_stock, goods_sign_plan, first_observed_at, last_observed_at,
      observation_count)
    VALUES (${appId}, 'taobao', ${productKey}, NULL, 'detail', ${values.priceFen.toString()}::bigint,
      ${values.couponFen.toString()}::bigint, ${values.finalPriceFen.toString()}::bigint,
      ${values.inStock}, NULL, ${instant}, ${instant}, 1)
  `.execute(executor);
}

/** The four run values plus first / last / count of a row, as literals compare them. */
function fullRun(values: PriceSnapshotValues, first: Date, last: Date, count: number) {
  return {
    product_key: 'tb:123',
    source_kind: 'detail',
    price_fen: values.priceFen,
    coupon_fen: values.couponFen,
    final_price_fen: values.finalPriceFen,
    in_stock: values.inStock,
    first_observed_at: first,
    last_observed_at: last,
    observation_count: count,
  };
}

it('[AC-B1-17b#34] BR-WATCH-05 细则例落库：08:00/14:00 4500、17:00 超时、20:00/20:05/20:15 3900 → 两行 watch', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const clock = new FixedClock(at('08:00'));
  const { recorder } = recorderOn(store, clock);
  const appId = 'ph-int-example-05';
  const watch = (fen: bigint, outcome: PriceObservation['outcome'] = 'ok') =>
    observation({ appId, sourceKind: 'watch', priceFen: fen, finalPriceFen: fen, outcome });
  await observeAt(recorder, clock, at('08:00'), watch(4500n));
  await observeAt(recorder, clock, at('14:00'), watch(4500n));
  await observeAt(recorder, clock, at('17:00'), watch(4500n, 'timeout'));
  await observeAt(recorder, clock, at('20:00'), watch(3900n));
  await observeAt(recorder, clock, at('20:05'), watch(3900n));
  await observeAt(recorder, clock, at('20:15'), watch(3900n));
  expect((await rows(appId)).map(runOf)).toEqual([
    {
      product_key: 'tb:123',
      source_kind: 'watch',
      price_fen: 4500n,
      coupon_fen: 0n,
      final_price_fen: 4500n,
      in_stock: true,
      first_observed_at: at('08:00'),
      last_observed_at: at('14:00'),
      observation_count: 2,
    },
    {
      product_key: 'tb:123',
      source_kind: 'watch',
      price_fen: 3900n,
      coupon_fen: 0n,
      final_price_fen: 3900n,
      in_stock: true,
      first_observed_at: at('20:00'),
      last_observed_at: at('20:15'),
      observation_count: 2,
    },
  ]);
  expect(recorder.failureCount()).toBe(0);
}, 30_000);

it('[AC-B1-17b#35] BR-WATCH-19 细则例落库：详情 09-30/10-01 4500、10-02 3900，10-02 转链不写 → 两行 detail', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const clock = new FixedClock(at('10:00', '2031-09-30'));
  const { recorder } = recorderOn(store, clock);
  const appId = 'ph-int-example-19';
  const detail = (fen: bigint) => observation({ appId, priceFen: fen, finalPriceFen: fen });
  await observeAt(recorder, clock, at('10:00', '2031-09-30'), detail(4500n));
  await observeAt(recorder, clock, at('10:00', '2031-10-01'), detail(4500n));
  await observeAt(recorder, clock, at('10:00', '2031-10-02'), detail(3900n));
  await observeAt(
    recorder,
    clock,
    at('10:05', '2031-10-02'),
    observation({
      appId,
      sourceKind: 'convert',
      priceFen: 3900n,
      finalPriceFen: 3900n,
      userScoped: true,
    }),
  );
  expect((await rows(appId)).map(runOf)).toEqual([
    {
      product_key: 'tb:123',
      source_kind: 'detail',
      price_fen: 4500n,
      coupon_fen: 0n,
      final_price_fen: 4500n,
      in_stock: true,
      first_observed_at: at('10:00', '2031-09-30'),
      last_observed_at: at('10:00', '2031-10-01'),
      observation_count: 2,
    },
    {
      product_key: 'tb:123',
      source_kind: 'detail',
      price_fen: 3900n,
      coupon_fen: 0n,
      final_price_fen: 3900n,
      in_stock: true,
      first_observed_at: at('10:00', '2031-10-02'),
      last_observed_at: at('10:00', '2031-10-02'),
      observation_count: 1,
    },
  ]);
}, 30_000);

it('[AC-B1-17b#36] 只在同一 (app_id, product_key, source_kind) 内比较：同价的 search 与另一 app 各起一行，互不前移', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const clock = new FixedClock(at('08:00'));
  const { recorder } = recorderOn(store, clock);
  const appA = 'ph-int-scope-a';
  const appB = 'ph-int-scope-b';
  await observeAt(recorder, clock, at('08:00'), observation({ appId: appA }));
  await observeAt(recorder, clock, at('08:01'), observation({ appId: appA, sourceKind: 'search' }));
  await observeAt(recorder, clock, at('08:02'), observation({ appId: appB }));
  await observeAt(recorder, clock, at('08:03'), observation({ appId: appA, productKey: 'tb:456' }));
  await observeAt(recorder, clock, at('08:30'), observation({ appId: appA }));
  expect((await rows(appA)).map(runOf)).toEqual([
    expect.objectContaining({
      product_key: 'tb:123',
      source_kind: 'detail',
      first_observed_at: at('08:00'),
      last_observed_at: at('08:30'),
      observation_count: 2,
    }),
    expect.objectContaining({
      product_key: 'tb:123',
      source_kind: 'search',
      first_observed_at: at('08:01'),
      last_observed_at: at('08:01'),
      observation_count: 1,
    }),
    expect.objectContaining({
      product_key: 'tb:456',
      source_kind: 'detail',
      first_observed_at: at('08:03'),
      last_observed_at: at('08:03'),
      observation_count: 1,
    }),
  ]);
  expect((await rows(appB)).map(runOf)).toEqual([
    expect.objectContaining({
      product_key: 'tb:123',
      source_kind: 'detail',
      first_observed_at: at('08:02'),
      last_observed_at: at('08:02'),
      observation_count: 1,
    }),
  ]);
}, 30_000);

it('[AC-B1-17b#37] 写入行只有表定义的列、不含任何用户标识；拼多多写 goods_sign_plan；时间取注入的 Clock 而非 now()', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const clock = new FixedClock(at('08:00', '2033-01-15'));
  const { recorder } = recorderOn(store, clock);
  const appId = 'ph-int-columns';
  const smuggled = {
    ...observation({
      appId,
      platform: 'pdd',
      productKey: 'pdd:88',
      skuKey: 'sku-9',
      goodsSignPlan: 'search',
    }),
    userId: 'u-secret',
    deviceId: 'd-secret',
    relationId: 'r-secret',
    subUnionId: 's-secret',
    customParameters: 'c-secret',
  } as PriceObservation;
  await observeAt(recorder, clock, at('08:00', '2033-01-15'), smuggled);
  const stored = await rows(appId);
  expect(stored).toHaveLength(1);
  const row = stored[0]!;
  expect(Object.keys(row).sort()).toEqual(COLUMNS);
  expect(row).toMatchObject({
    app_id: appId,
    platform: 'pdd',
    product_key: 'pdd:88',
    sku_key: 'sku-9',
    source_kind: 'detail',
    goods_sign_plan: 'search',
    first_observed_at: at('08:00', '2033-01-15'),
    last_observed_at: at('08:00', '2033-01-15'),
    observation_count: 1,
  });
  expect(JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}` : v))).not.toMatch(
    /secret/,
  );
}, 30_000);

it('[AC-B1-17b#38] 前移只 UPDATE last_observed_at 与 observation_count，其余列（含 first_observed_at、created_at）不变', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const appId = 'ph-int-touch';
  const key = { appId, productKey: 'tb:123' };
  expect(await store.write(storeWrite(key, vals(4500n), at('08:00')))).toBe('inserted');
  const [before] = await rows(appId);
  expect(await store.write(storeWrite(key, vals(4500n), at('08:09')))).toBe('unchanged');
  expect(await store.write(storeWrite(key, vals(4500n), at('08:25')))).toBe('touched');
  const after = await rows(appId);
  expect(after).toEqual([{ ...before, last_observed_at: at('08:25'), observation_count: 2 }]);
  expect(await store.write(storeWrite(key, vals(4500n), at('08:20'), 1))).toBe('unchanged');
  expect(await store.write(storeWrite(key, vals(4500n), at('08:40'), 30))).toBe('unchanged');
  expect(await store.write(storeWrite(key, vals(4500n), at('08:55'), 30))).toBe('touched');
  expect(await store.write(storeWrite(key, vals(3900n), at('08:56'), 30))).toBe('inserted');
  expect((await rows(appId)).map(runOf)).toEqual([
    expect.objectContaining({
      price_fen: 4500n,
      last_observed_at: at('08:55'),
      observation_count: 3,
    }),
    expect.objectContaining({
      price_fen: 3900n,
      first_observed_at: at('08:56'),
      last_observed_at: at('08:56'),
      observation_count: 1,
    }),
  ]);
}, 30_000);

it('[AC-B1-17b#39] 最新行按 first_observed_at 取：回到旧价开新行，之后与新行比较', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const appId = 'ph-int-latest';
  const key = { appId, productKey: 'tb:123' };
  expect(await store.write(storeWrite(key, vals(4500n), at('08:00')))).toBe('inserted');
  expect(await store.write(storeWrite(key, vals(3900n), at('09:00')))).toBe('inserted');
  expect(await store.write(storeWrite(key, vals(4500n), at('10:00')))).toBe('inserted');
  expect(await store.write(storeWrite(key, vals(4500n), at('10:30')))).toBe('touched');
  expect((await rows(appId)).map((r) => [r['price_fen'], r['observation_count']])).toEqual([
    [4500n, 1],
    [3900n, 1],
    [4500n, 2],
  ]);
}, 30_000);

it('[AC-B1-17b#40] advisory lock 串行：持锁期间同键写入等待；等待期间另一写者先提交同价行，放行后只前移不另插', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const appId = 'ph-int-lock';
  const productKey = 'tb:L1';
  const lockKey = priceSnapshotLockKey(appId, productKey, 'detail');
  const holder = await db.startTransaction().execute();
  let pending: Promise<
    { status: 'fulfilled'; value: unknown } | { status: 'rejected'; error: unknown }
  > | null = null;
  try {
    await sql`SET LOCAL statement_timeout = '10s'`.execute(holder);
    await sql`SELECT pg_advisory_xact_lock(${lockKey.toString()}::bigint)`.execute(holder);
    pending = store.write(storeWrite({ appId, productKey }, vals(4500n), at('08:20'))).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await expect
      .poll(
        async () => {
          const waiting = await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          `.execute(holder);
          return waiting.rows[0]?.n;
        },
        { timeout: 5_000, interval: 10 },
      )
      .toBe(1);
    // The competing writer's row, committed while the store waits on the lock.
    await insertRun(holder, appId, productKey, 4500n, at('08:00'));
    await holder.commit().execute();
    expect(await pending).toEqual({ status: 'fulfilled', value: 'touched' });
  } finally {
    if (!holder.isCommitted && !holder.isRolledBack) await holder.rollback().execute();
    if (pending !== null) await pending;
  }
  expect((await rows(appId)).map(runOf)).toEqual([
    expect.objectContaining({
      price_fen: 4500n,
      first_observed_at: at('08:00'),
      last_observed_at: at('08:20'),
      observation_count: 2,
    }),
  ]);
}, 30_000);

it('[AC-B1-17b#41] 不同键不同锁：持有键 A 的锁时，同 app 同商品另一 source_kind 与另一商品的写入照常完成', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const appId = 'ph-int-lock-other';
  const held = priceSnapshotLockKey(appId, 'tb:A', 'detail');
  const holder = await db.startTransaction().execute();
  try {
    await sql`SET LOCAL statement_timeout = '10s'`.execute(holder);
    await sql`SELECT pg_advisory_xact_lock(${held.toString()}::bigint)`.execute(holder);
    const timeout = (ms: number) =>
      new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), ms));
    const otherKind = store.write(
      storeWrite({ appId, productKey: 'tb:A', sourceKind: 'search' }, vals(4500n), at('08:00')),
    );
    expect(await Promise.race([otherKind, timeout(5_000)])).toBe('inserted');
    const otherProduct = store.write(
      storeWrite({ appId, productKey: 'tb:B' }, vals(4500n), at('08:00')),
    );
    expect(await Promise.race([otherProduct, timeout(5_000)])).toBe('inserted');
  } finally {
    await holder.rollback().execute();
  }
  expect(await rows(appId)).toHaveLength(2);
}, 30_000);

it('[AC-B1-17b#42] 并发：同键 8 个同时写入同价（3 轮新键）只插一行；再 8 个同时刻写入只前移一次', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const appId = 'ph-int-concurrent';
  for (const round of [1, 2, 3]) {
    const key = { appId, productKey: `tb:C${round}` };
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => store.write(storeWrite(key, vals(4500n), at('08:00')))),
    );
    expect(outcomes.filter((o) => o === 'inserted')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'unchanged')).toHaveLength(7);
    const touched = await Promise.all(
      Array.from({ length: 8 }, () => store.write(storeWrite(key, vals(4500n), at('08:20')))),
    );
    expect(touched.filter((o) => o === 'touched')).toHaveLength(1);
  }
  const stored = (await rows(appId)).map(runOf);
  expect(stored).toHaveLength(3);
  for (const row of stored) {
    expect(row).toMatchObject({
      first_observed_at: at('08:00'),
      last_observed_at: at('08:20'),
      observation_count: 2,
    });
  }
}, 60_000);

it('[AC-B1-17b#43] 数据库不可用：record 不抛、drain 完成，只尝试一次、计数 + 1、warn code=PRICE_SNAPSHOT_WRITE_FAILED，无行写入', async () => {
  const deadDb = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  // Kysely's destroy() is a no-op on a driver that was never initialised; run one query first so
  // destroyDb really ends the pool (orchestrator's mechanical fix, B1-17b CI verify-int run 1).
  await sql`SELECT 1`.execute(deadDb);
  await destroyDb(deadDb);
  const store = createKyselyPriceSnapshotStore(deadDb);
  const spied = {
    write: vi.fn((input: Parameters<PriceSnapshotStore['write']>[0]) => store.write(input)),
  };
  const clock = new FixedClock(at('08:00'));
  const { recorder, warn } = recorderOn(spied, clock);
  const appId = 'ph-int-db-down';
  expect(() => recorder.record(observation({ appId }))).not.toThrow();
  await expect(recorder.drain()).resolves.toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await recorder.drain();
  expect(spied.write).toHaveBeenCalledTimes(1);
  expect(recorder.failureCount()).toBe(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]![0]).toMatchObject({ code: 'PRICE_SNAPSHOT_WRITE_FAILED' });
  expect(await rows(appId)).toEqual([]);
}, 30_000);

it('[AC-B1-17b#44] 非默认触达间隔经配置生效：配置 30 分钟时 20 分钟后同价不前移、35 分钟后前移', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const clock = new FixedClock(at('08:00'));
  const { recorder } = recorderOn(store, clock, intervalConfig(30));
  const appId = 'ph-int-interval';
  await observeAt(recorder, clock, at('08:00'), observation({ appId }));
  await observeAt(recorder, clock, at('08:20'), observation({ appId }));
  expect((await rows(appId)).map(runOf)).toEqual([
    expect.objectContaining({ last_observed_at: at('08:00'), observation_count: 1 }),
  ]);
  await observeAt(recorder, clock, at('08:35'), observation({ appId }));
  expect((await rows(appId)).map(runOf)).toEqual([
    expect.objectContaining({ last_observed_at: at('08:35'), observation_count: 2 }),
  ]);
}, 30_000);

it('[AC-B1-17b#47] BR-WATCH-05 四值落库比较（合法联盟返回）：只变库存、同原价换券、券后价不变而原价与券同变，各开新行，旧行不动', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const clock = new FixedClock(at('08:00'));
  const { recorder } = recorderOn(store, clock);
  const appId = 'ph-int-four-values';
  const base = vals(4500n);
  const outOfStock = vals(4500n, { inStock: false });
  const couponed = vals(4500n, { couponFen: 500n, finalPriceFen: 4000n, inStock: false });
  const repriced = vals(4600n, { couponFen: 600n, finalPriceFen: 4000n, inStock: false });
  const steps: [string, PriceSnapshotValues][] = [
    ['08:00', base],
    ['08:20', outOfStock],
    ['08:40', couponed],
    ['09:00', repriced],
  ];
  for (const [hhmm, v] of steps) {
    await observeAt(
      recorder,
      clock,
      at(hhmm),
      observation({
        appId,
        priceFen: v.priceFen,
        couponFen: v.couponFen,
        finalPriceFen: v.finalPriceFen,
        inStock: v.inStock,
      }),
    );
  }
  expect((await rows(appId)).map(runOf)).toEqual([
    fullRun(vals(4500n), at('08:00'), at('08:00'), 1),
    fullRun(vals(4500n, { inStock: false }), at('08:20'), at('08:20'), 1),
    fullRun(
      vals(4500n, { couponFen: 500n, finalPriceFen: 4000n, inStock: false }),
      at('08:40'),
      at('08:40'),
      1,
    ),
    fullRun(
      vals(4600n, { couponFen: 600n, finalPriceFen: 4000n, inStock: false }),
      at('09:00'),
      at('09:00'),
      1,
    ),
  ]);
  expect(recorder.failureCount()).toBe(0);
}, 30_000);

it.each([
  ['price_fen', vals(4500n, { couponFen: 500n, finalPriceFen: 4000n }), { priceFen: 4600n }],
  ['coupon_fen', vals(4500n, { couponFen: 500n, finalPriceFen: 4000n }), { couponFen: 600n }],
  [
    'final_price_fen',
    vals(4500n, { couponFen: 500n, finalPriceFen: 4000n }),
    { finalPriceFen: 3900n },
  ],
  ['in_stock', vals(4500n, { couponFen: 500n, finalPriceFen: 4000n }), { inStock: false }],
  ['price_fen 1 → 2^31 + 1', vals(1n), { priceFen: 2_147_483_649n, finalPriceFen: 1n }],
  ['price_fen 1 → 2^32 + 1', vals(1n), { priceFen: 4_294_967_297n, finalPriceFen: 1n }],
  ['final_price_fen 1 → 2^32 + 1', vals(1n), { priceFen: 1n, finalPriceFen: 4_294_967_297n }],
] as const)(
  '[AC-B1-17b#48] 仓储按四值逐个比较（仓储不做 BR-PRICE-01 校验，那是记录入口的事）：只变 %s 且间隔已够 → inserted，新行四值齐全、旧行不前移',
  async (name, before, change) => {
    const store = createKyselyPriceSnapshotStore(db);
    const appId = `ph-int-field-${name.replace(/[^a-z0-9]+/gi, '-')}`;
    const key = { appId, productKey: 'tb:123' };
    const after: PriceSnapshotValues = { ...before, ...change };
    expect(await store.write(storeWrite(key, before, at('08:00')))).toBe('inserted');
    expect(await store.write(storeWrite(key, after, at('08:20')))).toBe('inserted');
    expect((await rows(appId)).map(runOf)).toEqual([
      fullRun(before, at('08:00'), at('08:00'), 1),
      fullRun(after, at('08:20'), at('08:20'), 1),
    ]);
  },
  30_000,
);

it('[AC-B1-17b#49] 最新行在 first_observed_at 相同时按 id 取大者：大 id 同价 → 只前移它；小 id 同价 → 另插新行', async () => {
  const store = createKyselyPriceSnapshotStore(db);
  const appId = 'ph-int-tie';
  // Key A: smaller id 4500, larger id 3900. Key B: smaller id 3900, larger id 4500.
  await insertRow(db, appId, 'tb:TA', vals(4500n), at('08:00'));
  await insertRow(db, appId, 'tb:TA', vals(3900n), at('08:00'));
  await insertRow(db, appId, 'tb:TB', vals(3900n), at('08:00'));
  await insertRow(db, appId, 'tb:TB', vals(4500n), at('08:00'));
  const fixture = (await rows(appId)).map((r) => ({
    key: r['product_key'],
    price: r['price_fen'],
    id: BigInt(`${r['id'] as string | number | bigint}`),
  }));
  // rows() orders by product_key, source_kind, first_observed_at, id: insertion order = id order.
  expect(fixture.map((f) => [f.key, f.price])).toEqual([
    ['tb:TA', 4500n],
    ['tb:TA', 3900n],
    ['tb:TB', 3900n],
    ['tb:TB', 4500n],
  ]);
  expect(fixture[0]!.id < fixture[1]!.id && fixture[2]!.id < fixture[3]!.id).toBe(true);
  expect(
    await store.write(storeWrite({ appId, productKey: 'tb:TA' }, vals(3900n), at('08:30'))),
  ).toBe('touched');
  expect(
    await store.write(storeWrite({ appId, productKey: 'tb:TB' }, vals(3900n), at('08:30'))),
  ).toBe('inserted');
  expect(
    (await rows(appId)).map((r) => [
      r['product_key'],
      r['price_fen'],
      r['first_observed_at'],
      r['last_observed_at'],
      r['observation_count'],
    ]),
  ).toEqual([
    ['tb:TA', 4500n, at('08:00'), at('08:00'), 1],
    ['tb:TA', 3900n, at('08:00'), at('08:30'), 2],
    ['tb:TB', 3900n, at('08:00'), at('08:00'), 1],
    ['tb:TB', 4500n, at('08:00'), at('08:00'), 1],
    ['tb:TB', 3900n, at('08:30'), at('08:30'), 1],
  ]);
}, 30_000);
