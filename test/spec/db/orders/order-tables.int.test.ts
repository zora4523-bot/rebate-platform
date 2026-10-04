// Rule tests for the order tables of B1-08a (规划/04 §3.2 rows order_keys, orders, order_rights,
// order_settlements; §2.3 维权枚举 and hold_reason; contracts/enums/order.yaml; ADR-0001 §4.1,
// §4.2 #4, #8; db/AGENTS.md rules 4–8; 08 BR-ATTR-22, BR-FUND-02, BR-FUND-05, BR-FUND-06,
// BR-FUND-09, BR-ID-30 ⑰). Real PostgreSQL as the business roles. Columns whose shape 04 leaves
// to the implementation are filled from the catalog by kit.ts.
// Out of scope by the orchestrator's decision: any value rule of the four redundant amounts
// (BR-CALC-27 pending) and the order_sync pending table (fa-m04).
// Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ATTR_AT,
  FOREIGN_KEY_VIOLATION,
  ORDER_TABLES,
  PERMISSION_DENIED,
  REJECTED_VALUE,
  UNIQUE_VIOLATION,
  checkedLiterals,
  column,
  columns,
  foreignKeys,
  hasPrivilege,
  insertRow,
  newOrder,
  newOrderKey,
  sqlState,
  unique,
  useDb,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let payout: Kysely<DB>;
let readonly: Kysely<DB>;
let maint: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 1 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
  useDb(app);
});

afterAll(async () => {
  await Promise.all([app, payout, readonly, maint].map((db) => destroyDb(db)));
  await database.drop();
});

const INTEGER_TYPES = ['int2', 'int4', 'int8'];

async function newRights(values: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return insertRow('order_rights', {
    app_id: 'couli',
    order_id: (await newOrderKey()).orderId,
    type: 'RIGHTS',
    status: 'PROCESSING',
    ...values,
  });
}

async function newSettlement(
  values: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return insertRow('order_settlements', {
    app_id: 'couli',
    order_id: (await newOrderKey()).orderId,
    seq: 1,
    source: 'API',
    settle_commission_fen: 1234,
    settled_at: new Date('2026-10-05T06:30:00Z'),
    content_hash: unique('hash'),
    ...values,
  });
}

// ---------------------------------------------------------------------------------------------
// Common rules (db/AGENTS.md #7; ADR-0001 §4.1)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-08a#1] the four order tables exist in schema app and carry app_id NOT NULL', async () => {
  for (const table of ORDER_TABLES) {
    const appId = await column(table, 'app_id');
    expect(appId, table).toBeDefined();
    expect(appId?.nullable, table).toBe(false);
  }
});

it('[AC-B1-08a#2] foreign keys of the order tables never cascade and never target a partitioned table', async () => {
  for (const table of ORDER_TABLES) {
    for (const fk of await foreignKeys(table)) {
      const label = `${table}.${fk.name} → ${fk.target}`;
      // a = NO ACTION, r = RESTRICT; c = CASCADE, n = SET NULL, d = SET DEFAULT are forbidden.
      expect(['a', 'r'], label).toContain(fk.onDelete);
      expect(['a', 'r'], label).toContain(fk.onUpdate);
      expect(fk.targetKind, label).not.toBe('p');
    }
  }
});

it('[AC-B1-08a#3] external ids of the order tables are text (ADR-0001 §4.1)', async () => {
  for (const [table, name] of [
    ['order_keys', 'sub_order_id'],
    ['orders', 'sub_order_id'],
    ['orders', 'parent_order_id'],
    ['orders', 'raw_item_id'],
    ['orders', 'shop_id'],
    ['orders', 'pid'],
    ['orders', 'relation_id'],
    ['order_rights', 'platform_rights_no'],
  ] as const) {
    expect((await column(table, name))?.type, `${table}.${name}`).toBe('text');
  }
});

it('[AC-B1-08a#4] no trigger on the order tables fires on INSERT or AFTER the write (db/AGENTS.md #8)', async () => {
  // Only "reject UPDATE / DELETE" triggers are allowed: BEFORE, row level, UPDATE or DELETE only.
  const rows = await sql<{ table: string; name: string; type: number }>`
    SELECT c.relname AS table, t.tgname AS name, t.tgtype::int AS type
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND NOT t.tgisinternal
      AND c.relname IN ('order_keys', 'orders', 'order_rights', 'order_settlements')
  `.execute(app);
  expect(Array.isArray(rows.rows)).toBe(true);
  for (const { table, name, type } of rows.rows) {
    // tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE, 64 INSTEAD.
    expect(type & 4, `${table}.${name} fires on INSERT`).toBe(0);
    expect(type & 2, `${table}.${name} is not BEFORE`).toBe(2);
  }
});

// ---------------------------------------------------------------------------------------------
// order_keys (04 §3.2 order_keys; BR-ATTR-22; TECH-09)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-08a#5] order_keys has platform, sub_order_id, order_id, app_id, attr_at, created_at and is not partitioned', async () => {
  const cols = new Map((await columns('order_keys')).map((c) => [c.name, c]));
  for (const name of ['platform', 'sub_order_id', 'order_id', 'app_id', 'attr_at', 'created_at']) {
    expect(cols.get(name)?.nullable, name).toBe(false);
  }
  expect(cols.get('attr_at')?.type).toBe('timestamptz');
  expect(cols.get('created_at')?.type).toBe('timestamptz');
  expect(cols.get('created_at')?.hasDefault).toBe(true);
  expect(cols.get('attr_at')?.hasDefault).toBe(false);
  const kind = await sql<{ kind: string }>`
    SELECT c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = 'order_keys'
  `.execute(app);
  expect(kind.rows).toEqual([{ kind: 'r' }]);
});

it('[AC-B1-08a#6] the primary key of order_keys is (platform, sub_order_id)', async () => {
  const rows = await sql<{ cols: string }>`
    SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS cols
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE n.nspname = 'app' AND t.relname = 'order_keys' AND c.contype = 'p'
    GROUP BY c.oid
  `.execute(app);
  expect(rows.rows).toEqual([{ cols: 'platform,sub_order_id' }]);
});

it('[AC-B1-08a#7] one sub-order of a platform has one global key, in every app (BR-ATTR-22)', async () => {
  const key = await newOrderKey();
  expect(
    await sqlState(newOrderKey({ platform: key.platform, sub_order_id: key.subOrderId })),
  ).toBe(UNIQUE_VIOLATION);
  expect(
    await sqlState(
      newOrderKey({ app_id: 'couli_two', platform: key.platform, sub_order_id: key.subOrderId }),
    ),
  ).toBe(UNIQUE_VIOLATION);
  // The same sub_order_id on another platform is another order.
  expect(await sqlState(newOrderKey({ platform: 'jd', sub_order_id: key.subOrderId }))).toBe(
    'no error',
  );
});

it('[AC-B1-08a#8] order_id is unique in order_keys', async () => {
  const key = await newOrderKey();
  for (const attrAt of [ATTR_AT, new Date('2026-11-04T08:00:00Z')]) {
    expect(await sqlState(newOrderKey({ order_id: key.orderId, attr_at: attrAt }))).toBe(
      UNIQUE_VIOLATION,
    );
  }
});

it('[AC-B1-08a#9] order_keys.attr_at never changes once written (04 §3.2 order_keys)', async () => {
  const key = await newOrderKey();
  expect(
    await sqlState(
      sql`UPDATE app.order_keys SET attr_at = ${new Date('2026-11-04T08:00:00Z')}
          WHERE order_id = ${key.orderId}`.execute(app),
    ),
  ).not.toBe('no error');
  const stored = await sql<{ same: boolean }>`
    SELECT attr_at = ${ATTR_AT}::timestamptz AS same FROM app.order_keys
    WHERE order_id = ${key.orderId}
  `.execute(app);
  expect(stored.rows).toEqual([{ same: true }]);
});

// ---------------------------------------------------------------------------------------------
// orders (04 §3.2 orders; BR-ATTR-22, BR-ATTR-25, BR-FUND-02, BR-FUND-05, BR-FUND-06)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-08a#10] orders is range-partitioned on attr_at (BR-ATTR-22, BR-ATTR-25)', async () => {
  const parent = await sql<{ kind: string; key: string }>`
    SELECT c.relkind::text AS kind, pg_get_partkeydef(c.oid) AS key
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = 'orders'
  `.execute(app);
  expect(parent.rows).toEqual([{ kind: 'p', key: 'RANGE (attr_at)' }]);
  const attrAt = await column('orders', 'attr_at');
  expect(attrAt?.type).toBe('timestamptz');
  expect(attrAt?.nullable).toBe(false);
});

it('[AC-B1-08a#11] an order needs its order_keys row: one orders row per key (04 §3.2: 唯一性由 order_keys 保证)', async () => {
  // No key row: rejected.
  const sample = await newOrderKey();
  expect(
    await sqlState(
      insertRow('orders', {
        app_id: 'couli',
        order_id: unusedOrderId(sample),
        platform: 'taobao',
        sub_order_id: unique('sub'),
        attr_at: ATTR_AT,
        raw_item_id: unique('item'),
      }),
    ),
  ).toBe(FOREIGN_KEY_VIOLATION);
  // Second row for the same key: rejected.
  const key = await newOrder();
  expect(await sqlState(newOrder({}, key))).not.toBe('no error');
  const count = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.orders WHERE order_id = ${key.orderId}
  `.execute(app);
  expect(count.rows).toEqual([{ n: '1' }]);
});

/** An order_id of the same type as the key's that has no order_keys row. */
function unusedOrderId(key: { orderId: unknown }): unknown {
  return typeof key.orderId === 'string' && /^[0-9a-f-]{36}$/.test(key.orderId)
    ? '00000000-0000-7000-8000-000000000000'
    : typeof key.orderId === 'string'
      ? unique('missing')
      : -1;
}

it('[AC-B1-08a#12] orders.attr_at equals order_keys.attr_at and never changes (04 §3.2 order_keys)', async () => {
  const key = await newOrderKey();
  expect(
    await sqlState(newOrder({}, { ...key, attrAt: new Date('2026-09-04T08:00:00Z') })),
  ).not.toBe('no error');
  await newOrder({}, key);
  expect(
    await sqlState(
      sql`UPDATE app.orders SET attr_at = ${new Date('2026-11-04T08:00:00Z')}
          WHERE order_id = ${key.orderId}`.execute(app),
    ),
  ).not.toBe('no error');
  const stored = await sql<{ same: boolean }>`
    SELECT attr_at = ${ATTR_AT}::timestamptz AS same FROM app.orders
    WHERE order_id = ${key.orderId}
  `.execute(app);
  expect(stored.rows).toEqual([{ same: true }]);
});

it('[AC-B1-08a#13] amounts of orders are bigint fen and rates are integer bp (db/AGENTS.md #7)', async () => {
  for (const name of [
    'pay_amount_fen',
    'est_commission_fen',
    'settle_commission_fen',
    'subsidy_commission_fen',
    'booked_base_fen',
    'booked_n_fen',
    'initial_est_fen',
  ]) {
    expect((await column('orders', name))?.type, name).toBe('int8');
  }
  for (const name of ['commission_rate_bp', 'commission_rate_min_bp', 'commission_rate_max_bp']) {
    expect(INTEGER_TYPES, name).toContain((await column('orders', name))?.type);
  }
  for (const c of await columns('orders')) {
    if (c.name.endsWith('_fen')) expect(c.type, c.name).toBe('int8');
    if (c.name.endsWith('_bp')) expect(INTEGER_TYPES, c.name).toContain(c.type);
  }
});

it('[AC-B1-08a#14] the four redundant amounts exist as nullable bigint without default (BR-CALC-27 pending, decision A)', async () => {
  for (const name of [
    'n_total_fen',
    'pre_base_deduct_fen',
    'base_fen',
    'platform_est_profit_fen',
  ]) {
    const c = await column('orders', name);
    expect(c, name).toBeDefined();
    expect(c?.type, name).toBe('int8');
    expect(c?.nullable, name).toBe(true);
    expect(c?.hasDefault, name).toBe(false);
  }
  // A row written before the values are decided keeps them empty.
  const key = await newOrder();
  const stored = await sql<{ empty: boolean }>`
    SELECT n_total_fen IS NULL AND pre_base_deduct_fen IS NULL AND base_fen IS NULL
           AND platform_est_profit_fen IS NULL AS empty
    FROM app.orders WHERE order_id = ${key.orderId}
  `.execute(app);
  expect(stored.rows).toEqual([{ empty: true }]);
});

it('[AC-B1-08a#15] orders keep no per-order credit date columns (04 §3.2: 月结后删除, FUND-01)', async () => {
  const names = (await columns('orders')).map((c) => c.name);
  for (const removed of ['credit_due_at', 'expected_credit_date', 'wait_days_snapshot']) {
    expect(names).not.toContain(removed);
  }
  expect(names).toContain('union_settled_at');
  expect(names).toContain('settle_period');
});

// Every column of the 04 §3.2 orders row (SPEC_REF 826f86e), plus app_id and order_id (the key
// shared with order_keys). Existence only: no value rule is asserted here.
const ORDERS_COLUMNS_04 = [
  'app_id',
  'order_id',
  'platform',
  'sub_order_id',
  'parent_order_id',
  'shop_type',
  'product_key',
  'raw_item_id',
  'shop_id',
  'title',
  'image_url',
  'quantity',
  'refunded_quantity',
  'refunded_quantity_at_credit',
  'pay_amount_fen',
  'pid',
  'relation_id',
  'sub_union_id',
  'custom_params',
  'link_id',
  'source_match',
  'user_id',
  'buy_type',
  'scene_basis',
  'user_basis',
  'platform_status',
  'rebate_status',
  'hold',
  'hold_reason',
  'rights_pending',
  'locked',
  'row_version',
  'commission_version',
  'reason',
  'reason_sub',
  'diff_reason_code',
  'is_presale',
  'deposit_paid_at',
  'paid_at',
  'paid_at_source',
  'attr_at',
  'received_at',
  'platform_received_at',
  'received_synced_at',
  'settled_at',
  'union_settled_at',
  'settle_period',
  'platform_modified_at',
  'credit_requires_settle',
  'credited_at',
  'est_commission_fen',
  'settle_commission_fen',
  'subsidy_commission_fen',
  'booked_base_fen',
  'booked_n_fen',
  'initial_est_fen',
  'n_total_fen',
  'pre_base_deduct_fen',
  'base_fen',
  'platform_est_profit_fen',
  'commission_rate_bp',
  'is_price_compare',
  'commission_rate_min_bp',
  'commission_rate_max_bp',
  'activity_type',
  'source_scene',
  'agent_session_id',
  'content_hash',
  'raw_payload_id',
];

it('[AC-B1-08a#40] orders has every column listed in 04 §3.2 orders', async () => {
  const names = new Set((await columns('orders')).map((c) => c.name));
  const missing = ORDERS_COLUMNS_04.filter((name) => !names.has(name));
  expect(missing).toEqual([]);
  for (const removed of ['credit_due_at', 'expected_credit_date', 'wait_days_snapshot']) {
    expect(names.has(removed), removed).toBe(false);
  }
});

it('[AC-B1-08a#16] platform_received_at is a nullable timestamptz beside received_at (BR-FUND-02)', async () => {
  for (const name of ['received_at', 'platform_received_at']) {
    const c = await column('orders', name);
    expect(c?.type, name).toBe('timestamptz');
    expect(c?.nullable, name).toBe(true);
  }
});

it('[AC-B1-08a#17] raw_item_id is required and product_key may be empty (04 §3.2 orders)', async () => {
  expect((await column('orders', 'raw_item_id'))?.nullable).toBe(false);
  expect((await column('orders', 'product_key'))?.nullable).toBe(true);
  expect(await sqlState(newOrder({ product_key: null }))).toBe('no error');
});

it('[AC-B1-08a#18] the price-comparison fields may be empty (BR-PRICE-07, BR-CALC-16)', async () => {
  for (const name of ['is_price_compare', 'commission_rate_min_bp', 'commission_rate_max_bp']) {
    expect((await column('orders', name))?.nullable, name).toBe(true);
  }
  expect((await column('orders', 'is_price_compare'))?.type).toBe('bool');
});

it('[AC-B1-08a#19] hold, rights_pending and credit_requires_settle are booleans (BR-FUND-06, BR-FUND-04)', async () => {
  for (const name of ['hold', 'rights_pending', 'credit_requires_settle', 'locked']) {
    expect((await column('orders', name))?.type, name).toBe('bool');
  }
});

it('[AC-B1-08a#20] hold_reason accepts RISK, CS and UNMAPPED_STATUS (contracts order_hold_reason, BR-FUND-02)', async () => {
  for (const reason of ['RISK', 'CS', 'UNMAPPED_STATUS']) {
    expect(await sqlState(newOrder({ hold: true, hold_reason: reason })), reason).toBe('no error');
  }
  // A CHECK on hold_reason, when present, lists exactly the contract values.
  const literals = await checkedLiterals('orders', 'hold_reason');
  if (literals.length > 0) {
    expect([...new Set(literals)].sort()).toEqual(['CS', 'RISK', 'UNMAPPED_STATUS']);
  }
});

it('[AC-B1-08a#21] orders accept every contract value of platform_status and rebate_status (BR-FUND-01)', async () => {
  for (const status of ['DEPOSIT_PAID', 'PAID', 'RECEIVED', 'SETTLED', 'INVALID']) {
    expect(await sqlState(newOrder({ platform_status: status })), status).toBe('no error');
  }
  for (const status of [
    'UNATTRIBUTED',
    'ESTIMATED',
    'WAITING',
    'CREDITED',
    'VOID',
    'CLAWED_BACK',
  ]) {
    expect(await sqlState(newOrder({ rebate_status: status })), status).toBe('no error');
  }
});

it('[AC-B1-08a#22] orders.row_version is an integer with DEFAULT 0 (ADR-0001 §4.1 CAS)', async () => {
  const c = await column('orders', 'row_version');
  expect(INTEGER_TYPES).toContain(c?.type);
  expect(c?.nullable).toBe(false);
  expect(c?.hasDefault).toBe(true);
  // An INSERT that leaves row_version out stores 0 (the filler never supplies it here).
  const key = await newOrderKey();
  await insertRow(
    'orders',
    {
      app_id: 'couli',
      order_id: key.orderId,
      platform: key.platform,
      sub_order_id: key.subOrderId,
      attr_at: key.attrAt,
      raw_item_id: unique('item'),
    },
    ['row_version'],
  );
  const stored = await sql<{ v: string }>`
    SELECT row_version::text AS v FROM app.orders WHERE order_id = ${key.orderId}
  `.execute(app);
  expect(stored.rows).toEqual([{ v: '0' }]);
});

it('[AC-B1-08a#23] the writer advances row_version itself: no trigger changes it (ADR-0001 §4.1, db/AGENTS.md #8)', async () => {
  const key = await newOrder();
  // A CAS write compares the previous version and increments it in the same UPDATE.
  const first = await sql`
    UPDATE app.orders SET title = 'renamed', row_version = row_version + 1
    WHERE order_id = ${key.orderId} AND row_version = 0
  `.execute(app);
  expect(first.numAffectedRows).toBe(1n);
  // A stale writer (still holding version 0) changes nothing.
  const stale = await sql`
    UPDATE app.orders SET title = 'stale', row_version = row_version + 1
    WHERE order_id = ${key.orderId} AND row_version = 0
  `.execute(app);
  expect(stale.numAffectedRows).toBe(0n);
  // An UPDATE that leaves row_version alone keeps it.
  await sql`UPDATE app.orders SET title = 'again' WHERE order_id = ${key.orderId}`.execute(app);
  const stored = await sql<{ v: string; title: string }>`
    SELECT row_version::text AS v, title::text AS title FROM app.orders
    WHERE order_id = ${key.orderId}
  `.execute(app);
  expect(stored.rows).toEqual([{ v: '1', title: 'again' }]);
});

// ---------------------------------------------------------------------------------------------
// order_rights (04 §3.2 order_rights, §2.3 维权枚举; BR-FUND-06)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-08a#24] order_rights.order_id references order_keys.order_id', async () => {
  const fks = await foreignKeys('order_rights');
  expect(
    fks.some(
      (fk) =>
        fk.target === 'order_keys' &&
        fk.columns.includes('order_id') &&
        fk.targetColumns[fk.columns.indexOf('order_id')] === 'order_id',
    ),
    JSON.stringify(fks),
  ).toBe(true);
  const key = await newOrderKey();
  expect(await sqlState(newRights({ order_id: unusedOrderId(key) }))).toBe(FOREIGN_KEY_VIOLATION);
});

it('[AC-B1-08a#25] order_rights.type is RIGHTS, PUNISH, INVALID_AFTER_SETTLE or REFUND_AFTER_SETTLE', async () => {
  for (const type of ['RIGHTS', 'PUNISH', 'INVALID_AFTER_SETTLE', 'REFUND_AFTER_SETTLE']) {
    expect(await sqlState(newRights({ type })), type).toBe('no error');
  }
  for (const type of ['REFUND', 'rights', '']) {
    expect(REJECTED_VALUE, JSON.stringify(type)).toContain(await sqlState(newRights({ type })));
  }
});

it('[AC-B1-08a#26] order_rights.status is PROCESSING, WAIT_COMMISSION, SUCCEEDED or FAILED', async () => {
  for (const status of ['PROCESSING', 'WAIT_COMMISSION', 'SUCCEEDED', 'FAILED']) {
    expect(await sqlState(newRights({ status })), status).toBe('no error');
  }
  for (const status of ['DONE', 'processing', '']) {
    expect(REJECTED_VALUE, JSON.stringify(status)).toContain(await sqlState(newRights({ status })));
  }
});

it('[AC-B1-08a#27] order_rights.amount_fen is bigint fen and occurred_at a timestamptz', async () => {
  expect((await column('order_rights', 'amount_fen'))?.type).toBe('int8');
  expect((await column('order_rights', 'occurred_at'))?.type).toBe('timestamptz');
  for (const c of await columns('order_rights')) {
    if (c.name.endsWith('_fen')) expect(c.type, c.name).toBe('int8');
  }
});

// ---------------------------------------------------------------------------------------------
// order_settlements (04 §3.2 order_settlements; BR-FUND-09, BR-FUND-02)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-08a#28] order_settlements.order_id references order_keys.order_id', async () => {
  const fks = await foreignKeys('order_settlements');
  expect(
    fks.some(
      (fk) =>
        fk.target === 'order_keys' &&
        fk.columns.includes('order_id') &&
        fk.targetColumns[fk.columns.indexOf('order_id')] === 'order_id',
    ),
    JSON.stringify(fks),
  ).toBe(true);
  const key = await newOrderKey();
  expect(await sqlState(newSettlement({ order_id: unusedOrderId(key) }))).toBe(
    FOREIGN_KEY_VIOLATION,
  );
});

it('[AC-B1-08a#29] one settlement record per (order_id, seq) (BR-FUND-09)', async () => {
  const first = await newSettlement();
  for (const source of ['API', 'STATEMENT']) {
    expect(await sqlState(newSettlement({ order_id: first['order_id'], seq: 1, source }))).toBe(
      UNIQUE_VIOLATION,
    );
  }
  expect(
    await sqlState(newSettlement({ order_id: first['order_id'], seq: 2, source: 'STATEMENT' })),
  ).toBe('no error');
});

it('[AC-B1-08a#30] order_settlements.source is API or STATEMENT (BR-FUND-09)', async () => {
  for (const source of ['API', 'STATEMENT']) {
    expect(await sqlState(newSettlement({ source })), source).toBe('no error');
  }
  for (const source of ['MANUAL', 'api', '']) {
    expect(REJECTED_VALUE, JSON.stringify(source)).toContain(
      await sqlState(newSettlement({ source })),
    );
  }
});

it('[AC-B1-08a#31] order_settlements columns: bigint commission, seq integer, settled_at, content_hash (BR-FUND-09)', async () => {
  const cols = new Map((await columns('order_settlements')).map((c) => [c.name, c]));
  expect(cols.get('settle_commission_fen')?.type).toBe('int8');
  expect(INTEGER_TYPES).toContain(cols.get('seq')?.type);
  expect(cols.get('seq')?.nullable).toBe(false);
  expect(cols.get('order_id')?.nullable).toBe(false);
  expect(cols.get('source')?.nullable).toBe(false);
  expect(cols.get('settled_at')?.type).toBe('timestamptz');
  expect(cols.has('content_hash')).toBe(true);
});

it('[AC-B1-08a#32] a settlement record is never rewritten or removed by couli_app (BR-FUND-09: each new record is seq+1)', async () => {
  const row = await newSettlement({ settle_commission_fen: 1000 });
  expect(
    await sqlState(
      sql`UPDATE app.order_settlements SET settle_commission_fen = 1
          WHERE order_id = ${row['order_id']}`.execute(app),
    ),
  ).not.toBe('no error');
  expect(
    await sqlState(
      sql`DELETE FROM app.order_settlements WHERE order_id = ${row['order_id']}`.execute(app),
    ),
  ).not.toBe('no error');
  const stored = await sql<{ fen: string }>`
    SELECT settle_commission_fen::text AS fen FROM app.order_settlements
    WHERE order_id = ${row['order_id']}
  `.execute(app);
  expect(stored.rows).toEqual([{ fen: '1000' }]);
});

// ---------------------------------------------------------------------------------------------
// Roles (db/AGENTS.md #4; ADR-0001 §4.2 #8; BR-ID-30 ⑰: order tables keep rows until the
// retention period is decided)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-08a#33] couli_app reads, inserts and updates orders but deletes none of the order tables (BR-ID-30 ⑰)', async () => {
  for (const table of ORDER_TABLES) {
    expect(await hasPrivilege('couli_app', table, 'SELECT'), `${table} SELECT`).toBe(true);
    expect(await hasPrivilege('couli_app', table, 'INSERT'), `${table} INSERT`).toBe(true);
    expect(await hasPrivilege('couli_app', table, 'DELETE'), `${table} DELETE`).toBe(false);
    expect(await hasPrivilege('couli_app', table, 'TRUNCATE'), `${table} TRUNCATE`).toBe(false);
  }
  expect(await hasPrivilege('couli_app', 'orders', 'UPDATE')).toBe(true);
  const key = await newOrder();
  expect(
    await sqlState(sql`DELETE FROM app.orders WHERE order_id = ${key.orderId}`.execute(app)),
  ).toBe(PERMISSION_DENIED);
  expect(
    await sqlState(
      sql`DELETE FROM app.orders_default WHERE order_id = ${key.orderId}`.execute(app),
    ),
  ).toBe(PERMISSION_DENIED);
  expect(
    await sqlState(sql`DELETE FROM app.order_keys WHERE order_id = ${key.orderId}`.execute(app)),
  ).toBe(PERMISSION_DENIED);
});

it('[AC-B1-08a#34] couli_readonly reads the order tables and cannot write them', async () => {
  for (const table of ORDER_TABLES) {
    expect(
      await sqlState(sql`SELECT 1 FROM ${sql.table(`app.${table}`)} LIMIT 1`.execute(readonly)),
      table,
    ).toBe('no error');
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(await hasPrivilege('couli_readonly', table, privilege), `${table} ${privilege}`).toBe(
        false,
      );
    }
  }
  expect(
    await sqlState(
      sql`INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at)
          VALUES ('taobao', 'x', ${String((await newOrderKey()).orderId)}, 'couli', now())`.execute(
        readonly,
      ),
    ),
  ).toBe(PERMISSION_DENIED);
});

it('[AC-B1-08a#35] couli_payout and couli_maint cannot write the order tables; couli_maint cannot read them', async () => {
  for (const table of ORDER_TABLES) {
    for (const role of ['couli_payout', 'couli_maint']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        expect(await hasPrivilege(role, table, privilege), `${role} ${table} ${privilege}`).toBe(
          false,
        );
      }
    }
    expect(
      await sqlState(sql`SELECT 1 FROM ${sql.table(`app.${table}`)} LIMIT 1`.execute(maint)),
      table,
    ).toBe(PERMISSION_DENIED);
  }
  expect(
    await sqlState(sql`UPDATE app.orders SET title = 'payout' WHERE false`.execute(payout)),
  ).toBe(PERMISSION_DENIED);
});
