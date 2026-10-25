// 维权单 / 违规单逐行处理（B1-09k）的连库夹具；只被 *.int.test.ts 引用，数据库生命周期在它们里管理。不引
// @couli/db/testing。处理器是本任务的 createRightsImportProcessors；settlement 的 rights.record 还没有实现
// （资金线 B2-04l），这里用假端口：在交给它的事务里按 order_rights 的去重键（app_id, order_id, type,
// platform_rights_no，NULLS NOT DISTINCT）插一行，冲突即 duplicate，只为看调用与写入落在哪个事务。
// 取值依据：08 BR-FUND-06 细则「维权导入任务」、任务书补充（判定顺序、违规单 SUCCEEDED、维权单状态按列、
// 表头模板待负责人样例 K-3，测试用合成表头注入登记；时间无偏移按 +08:00，同 B1-09h 的读表口径）。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Insertable, type Kysely, type Selectable, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import type {
  RightsImportCell,
  RightsImportRow,
  RightsImportRowProcessor,
  RightsImportTaskInfo,
  RightsImportTemplate,
} from '../../../../apps/api/src/modules/orders/application/rights-import-ports.ts';
import {
  createRightsImportProcessors,
  type RightsImportRowDeps,
} from '../../../../apps/api/src/modules/orders/application/rights-import-rows.ts';
import type {
  OrderRightsPorts,
  RightsCommandPort,
  RightsRecordInput,
  RightsRecordResult,
} from '../../../../apps/api/src/modules/orders/application/rights-ports.ts';
import type { RightsImportKind } from '../../../../apps/api/src/modules/orders/domain/rights-import.ts';
import { orderLockKeyText } from '../../../../apps/api/src/modules/orders/infra/order-lock.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { upload, xlsx } from '../rights-import-task/kit.ts';

/** 任务受理时刻（同 B1-09g 夹具的 NOW）与处理这一行时注入时钟的时刻。 */
export const IMPORTED = '2026-10-22T02:00:00.000Z';
export const PROCESSED = '2026-10-22T02:05:00.000Z';
/** 时间窗 [2026-10-01 00:00, 2026-10-16 00:00) +08:00：表单里的文本与对应的绝对时刻。 */
export const FROM_TEXT = '2026-10-01T00:00:00+08:00';
export const TO_TEXT = '2026-10-16T00:00:00+08:00';
export const FROM = '2026-09-30T16:00:00.000Z';
export const TO = '2026-10-15T16:00:00.000Z';
/** 订单的付款 / 收货时间：窗内与窗外。 */
export const PAID_IN = '2026-10-05T02:00:00.000Z';
export const PAID_OUT = '2026-10-20T02:00:00.000Z';
export const RECEIVED_IN = '2026-10-12T08:00:00.000Z';
export const RECEIVED_OUT = '2026-10-18T08:00:00.000Z';
/** 行里的发生时间（无偏移文本，按 +08:00）与它对应的绝对时刻。 */
export const OCCURRED_TEXT = '2026-10-18 10:30:00';
export const OCCURRED_AT = '2026-10-18T02:30:00.000Z';
/** 合成的平台维权单号 / 违规单号。 */
export const RIGHTS_NO = 'synthetic-rights-001';
export const OTHER_RIGHTS_NO = 'synthetic-rights-002';

export const at = (iso: string) => new FixedClock(iso).now();
export function plusMs(iso: string, ms: number): Date {
  const clock = new FixedClock(iso);
  clock.advanceMs(ms);
  return clock.now();
}

export const SUCCEEDED = { kind: 'succeeded' } as const;
export const SKIPPED = { kind: 'skipped' } as const;
export const DUPLICATE = { kind: 'duplicate' } as const;
export const failed = (reason: string) => ({ kind: 'failed', reason }) as const;

// ---------------------------------------------------------------- 合成表头模板（K-3 之前）

/** 模板列名 → 文件里的表头文字（维权单）。 */
export const RIGHTS_COLUMNS = {
  sub_order_id: '子订单号（合成）',
  parent_order_id: '主订单号（合成）',
  platform: '平台（合成）',
  rights_no: '维权单号（合成）',
  status: '维权状态（合成）',
  amount: '退款金额（合成）',
  deduction_commission: '应扣佣金（合成）',
  occurred_at: '发生时间（合成）',
} as const;
export type Column = keyof typeof RIGHTS_COLUMNS;

/** 违规单：没有状态列。 */
export const PUNISH_COLUMNS = {
  sub_order_id: RIGHTS_COLUMNS.sub_order_id,
  parent_order_id: RIGHTS_COLUMNS.parent_order_id,
  platform: RIGHTS_COLUMNS.platform,
  rights_no: '违规单号（合成）',
  amount: RIGHTS_COLUMNS.amount,
  deduction_commission: RIGHTS_COLUMNS.deduction_commission,
  occurred_at: '违规时间（合成）',
} as const;

export const RIGHTS_TEMPLATE: RightsImportTemplate = { columns: RIGHTS_COLUMNS };
export const PUNISH_TEMPLATE: RightsImportTemplate = { columns: PUNISH_COLUMNS };

/** Cells of one row; `undefined` drops the column (a template without it). */
export type Cells = Partial<Record<Column, RightsImportCell | undefined>>;

function valuesOf(defaults: Cells, patch: Cells): Record<string, RightsImportCell> {
  const merged: Cells = { ...defaults, ...patch };
  const values: Record<string, RightsImportCell> = {};
  for (const [name, cell] of Object.entries(merged)) {
    if (cell !== undefined) values[name] = cell;
  }
  return values;
}

/** One rights row as the job hands it (template columns → cells). */
export function rightsRow(subOrderId: RightsImportCell, patch: Cells = {}, rowNo = 2) {
  const defaults: Cells = {
    sub_order_id: subOrderId,
    parent_order_id: null,
    platform: 'taobao',
    rights_no: RIGHTS_NO,
    status: 'SUCCEEDED',
    amount: '12.30',
    deduction_commission: '1.23',
    occurred_at: OCCURRED_TEXT,
  };
  return { row_no: rowNo, values: valuesOf(defaults, patch) } satisfies RightsImportRow;
}

/** One punish row (no status column). */
export function punishRow(subOrderId: RightsImportCell, patch: Cells = {}, rowNo = 2) {
  const defaults: Cells = {
    sub_order_id: subOrderId,
    parent_order_id: null,
    platform: 'taobao',
    rights_no: RIGHTS_NO,
    amount: '12.30',
    deduction_commission: '1.23',
    occurred_at: OCCURRED_TEXT,
  };
  return { row_no: rowNo, values: valuesOf(defaults, patch) } satisfies RightsImportRow;
}

/** An xlsx upload under `columns`' header: one line per row, missing cells empty. */
export function fileOf(
  columns: Readonly<Record<string, string>>,
  rows: readonly Partial<Record<string, string | null>>[],
) {
  const names = Object.keys(columns);
  const header = names.map((name) => columns[name]!);
  return upload(xlsx([header, ...rows.map((row) => names.map((name) => row[name] ?? null))]));
}

// ---------------------------------------------------------------- database

/** The part of @couli/db/testing's TestDatabase this kit uses. */
export interface TestDatabaseUrls {
  urlFor(role: 'couli_app'): string;
}

export async function open(database: TestDatabaseUrls) {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 });
  return {
    db,
    async close() {
      await destroyDb(db);
    },
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;

export type Order = Selectable<DB['orders']>;
export type RightsRow = Selectable<DB['order_rights']>;

export const newAppId = () => `rr_${randomUUID().replaceAll('-', '').slice(0, 24)}`;

/** A synthetic all-digit order number, unique per call (order_keys is keyed by platform + number). */
export const orderNo = () =>
  `88${randomUUID()
    .replaceAll('-', '')
    .replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10))
    .slice(0, 16)}`;

/** One sub-order of `appId` (order_keys + orders); WAITING, paid PAID_IN, received RECEIVED_IN. */
export async function seedOrder(
  db: Kysely<DB>,
  appId: string,
  patch: Partial<Insertable<DB['orders']>> = {},
): Promise<Order> {
  const row = {
    order_id: randomUUID(),
    app_id: appId,
    platform: 'taobao',
    sub_order_id: orderNo(),
    parent_order_id: orderNo(),
    raw_item_id: 'synthetic-item',
    pay_amount_fen: 4567n,
    est_commission_fen: 321n,
    platform_status: 'RECEIVED',
    rebate_status: 'WAITING',
    hold: false,
    rights_pending: false,
    is_presale: false,
    paid_at: at(PAID_IN),
    received_at: at(RECEIVED_IN),
    settle_period: '2026-10',
    attr_at: at(PAID_IN),
    created_at: at(PAID_IN),
    updated_at: at(PAID_IN),
    ...patch,
  } satisfies Insertable<DB['orders']>;
  await db
    .insertInto('order_keys')
    .values({
      order_id: row.order_id,
      app_id: row.app_id,
      platform: row.platform,
      sub_order_id: row.sub_order_id,
      attr_at: row.attr_at,
      created_at: row.created_at,
    })
    .execute();
  await db.insertInto('orders').values(row).execute();
  return db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', row.app_id)
    .where('order_id', '=', row.order_id)
    .executeTakeFirstOrThrow();
}

export async function rightsOf(db: Kysely<DB>, appId: string): Promise<RightsRow[]> {
  return db
    .selectFrom('order_rights')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/** The columns of an order_rights row the import decides. */
export function rightsView(row: RightsRow) {
  return {
    order_id: row.order_id,
    source: row.source,
    type: row.type,
    status: row.status,
    amount_fen: row.amount_fen,
    deduction_commission_fen: row.deduction_commission_fen,
    occurred_at: row.occurred_at,
    platform_rights_no: row.platform_rights_no,
  };
}

/** The low 32 bits of the current transaction id of `trx`. */
export async function txidOn(trx: Transaction<DB>): Promise<string> {
  const query = sql<{ id: string }>`SELECT (txid_current() % 4294967296)::text AS id`;
  const { rows } = await query.execute(trx);
  return rows[0]!.id;
}

/** Whether another connection could take the sub-order advisory lock and the order row now. */
export async function probe(db: Kysely<DB>, o: Order) {
  return db.transaction().execute(async (other) => {
    const key = orderLockKeyText(o.platform, o.sub_order_id);
    const advisory = await sql<{
      got: boolean;
    }>`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as got`.execute(other);
    const rows = await other
      .selectFrom('orders')
      .select('order_id')
      .where('app_id', '=', o.app_id)
      .where('order_id', '=', o.order_id)
      .forUpdate()
      .skipLocked()
      .execute();
    return { advisoryFree: advisory.rows[0]?.got === true, rowFree: rows.length === 1 };
  });
}

export interface RecordCall {
  readonly input: RightsRecordInput;
  /** txid of the transaction rights.record was given. */
  readonly txid: string;
  readonly isTransaction: boolean;
  /** Filled when `control.probe` is on: the locks as another connection saw them. */
  readonly held: { advisoryFree: boolean; rowFree: boolean } | null;
}

/**
 * A stand-in for settlement's rights.record: inserts one order_rights row on the given transaction
 * under the dedupe key (conflict → duplicate). `control.answer` forces a reply without writing;
 * `control.fail` throws; `control.probe` records whether the sub-order's locks are held.
 */
export function fakeSettlement(db: Kysely<DB>) {
  const calls: RecordCall[] = [];
  const control: { answer?: RightsRecordResult; fail?: Error; probe?: boolean } = {};
  const record = vi.fn<RightsCommandPort['record']>(async (trx, input) => {
    const txid = await txidOn(trx);
    const held = control.probe === true ? await probe(db, input.before) : null;
    calls.push({ input, txid, isTransaction: trx.isTransaction, held });
    if (control.fail !== undefined) throw control.fail;
    if (control.answer !== undefined) return control.answer;
    const inserted = await trx
      .insertInto('order_rights')
      .values({
        id: randomUUID(),
        app_id: input.before.app_id,
        order_id: input.order_id,
        source: input.source,
        type: input.type,
        status: input.status,
        amount_fen: input.amount_fen,
        deduction_commission_fen: input.deduction_commission_fen,
        occurred_at: input.occurred_at,
        platform_rights_no: input.platform_rights_no,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .execute();
    return { kind: inserted.length === 1 ? 'applied' : 'duplicate' };
  });
  const ports: OrderRightsPorts = { rights: { record } };
  return { ports, record, calls, control };
}
export type Settlement = ReturnType<typeof fakeSettlement>;

/** The processor of `kind` from the factory; it must exist when rights.record is injected. */
export function processorOf(deps: RightsImportRowDeps, kind: 'rights' | 'punish') {
  const processor = createRightsImportProcessors(deps)[kind];
  expect(processor, `a ${kind} processor`).toBeDefined();
  return processor as RightsImportRowProcessor;
}

/** An app with an admin id; tasks are rights / punish imports of taobao without a window. */
export async function setup(db: Kysely<DB>) {
  const appId = newAppId();
  const adminId = randomUUID();
  const clock = new FixedClock(PROCESSED);
  const settlement = fakeSettlement(db);
  const deps: RightsImportRowDeps = { db, clock, ports: settlement.ports };

  function task(patch: Partial<RightsImportTaskInfo> = {}): RightsImportTaskInfo {
    return {
      import_id: randomUUID(),
      app_id: appId,
      kind: 'rights',
      platform: 'taobao',
      union_account_id: null,
      time_basis: null,
      from: null,
      to: null,
      created_by: adminId,
      created_at: at(IMPORTED),
      ...patch,
    };
  }

  /** A paid-basis or received-basis window [FROM, TO). */
  const window = (basis: 'paid' | 'received'): Partial<RightsImportTaskInfo> => ({
    time_basis: basis,
    from: at(FROM),
    to: at(TO),
  });

  const processor = (kind: 'rights' | 'punish' = 'rights') => processorOf(deps, kind);

  /** One row through a new processor of `kind`, without the job's transaction. */
  async function run(
    kind: Extract<RightsImportKind, 'rights' | 'punish'>,
    row: RightsImportRow,
    patch: Partial<RightsImportTaskInfo> = {},
  ) {
    return processor(kind).process(task({ kind, ...patch }), row);
  }

  return {
    db,
    appId,
    adminId,
    clock,
    settlement,
    record: settlement.record,
    calls: settlement.calls,
    deps,
    task,
    window,
    processor,
    run,
    order: (patch: Partial<Insertable<DB['orders']>> = {}, app = appId) =>
      seedOrder(db, app, patch),
    rights: (app = appId) => rightsOf(db, app),
  };
}
export type Fixture = Awaited<ReturnType<typeof setup>>;
