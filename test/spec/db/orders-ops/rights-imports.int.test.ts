// 04 §3.2 rights_imports / rights_import_failures; 08 BR-FUND-06 细则「维权导入任务」(duplicate_rows
// 与 skipped_rows 分开计数); 编排 B1-09e 技术取舍: time_basis 可空, kind=channel 时 union_account_id
// 必填且 time_basis / from / to 为空 (CHECK); failures (import_id, row_no) 唯一、reason CHECK 照
// CT-24n rights_import_failure_reason.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  FROM,
  RIGHTS_IMPORT_FAILURE_REASON,
  RIGHTS_IMPORT_KIND,
  RIGHTS_IMPORT_STATUS,
  RIGHTS_IMPORT_TIME_BASIS,
  TO,
  channelImport,
  columns,
  connect,
  expectCheckLists,
  expectForeignKey,
  importFailure,
  insert,
  newAccount,
  requireTable,
  rightsImport,
  sqlState,
  uniqueIndexesOn,
} from './kit.ts';

const IMPORTS = 'rights_imports';
const FAILURES = 'rights_import_failures';

let database: TestDatabase;
let app: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
});
afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

async function addImport(row: Record<string, unknown>): Promise<string> {
  return sqlState(insert(app, IMPORTS, row));
}

async function newImport(values: Record<string, unknown> = {}): Promise<unknown> {
  const row = await rightsImport(values);
  expect(await addImport(row)).toBe('no error');
  return row['id'];
}

async function addFailure(importId: unknown, values: Record<string, unknown>): Promise<string> {
  return sqlState(insert(app, FAILURES, await importFailure(importId, values)));
}

it('[B1-09e] rights_imports 有 04 §3.2 的全部列（含 duplicate_rows 与 skipped_rows 分列），time_basis 与时间窗可空', async () => {
  await requireTable(app, IMPORTS);
  const cols = await columns(IMPORTS);
  expect(cols.map((c) => c.name)).toEqual(
    expect.arrayContaining([
      'id',
      'app_id',
      'kind',
      'platform',
      'union_account_id',
      'time_basis',
      'from',
      'to',
      'file_path',
      'status',
      'total_rows',
      'succeeded_rows',
      'failed_rows',
      'skipped_rows',
      'duplicate_rows',
      'created_by',
      'created_at',
      'finished_at',
    ]),
  );
  const nullable = Object.fromEntries(cols.map((c) => [c.name, c.nullable]));
  expect(nullable).toMatchObject({
    app_id: false,
    kind: false,
    status: false,
    file_path: false,
    union_account_id: true,
    time_basis: true,
    from: true,
    to: true,
    finished_at: true,
  });
});

it('[B1-09e] rights_import_failures 有 import_id、row_no、reason 与 app_id，均非空', async () => {
  await requireTable(app, FAILURES);
  const cols = await columns(FAILURES);
  expect(cols.map((c) => c.name)).toEqual(
    expect.arrayContaining(['app_id', 'import_id', 'row_no', 'reason']),
  );
  const nullable = Object.fromEntries(cols.map((c) => [c.name, c.nullable]));
  expect(nullable).toMatchObject({ app_id: false, import_id: false, row_no: false, reason: false });
});

it('[B1-09e] kind=channel 缺 union_account_id 被 CHECK 拒绝（23514）', async () => {
  await requireTable(app, IMPORTS);
  expect(await addImport(await channelImport({ union_account_id: null }))).toBe('23514');
});

it.each(['time_basis', 'from', 'to'])(
  '[B1-09e] kind=channel 的 %s 非空被 CHECK 拒绝（23514）：渠道单三项时间窗恒为空',
  async (field) => {
    await requireTable(app, IMPORTS);
    const values: Record<string, unknown> = { time_basis: 'paid', from: FROM, to: TO };
    expect(await addImport(await channelImport({ [field]: values[field] }))).toBe('23514');
  },
);

it('[B1-09e] kind=channel 带联盟账号、三项时间窗为空时可以写入', async () => {
  await requireTable(app, IMPORTS);
  expect(await addImport(await channelImport())).toBe('no error');
});

it.each(['rights', 'punish'])(
  '[B1-09e] kind=%s 时 time_basis 可按 paid / received 写入，也可三项时间窗全空',
  async (kind) => {
    await requireTable(app, IMPORTS);
    for (const basis of RIGHTS_IMPORT_TIME_BASIS) {
      expect(await addImport(await rightsImport({ kind, time_basis: basis })), basis).toBe(
        'no error',
      );
    }
    expect(
      await addImport(await rightsImport({ kind, time_basis: null, from: null, to: null })),
    ).toBe('no error');
  },
);

it('[B1-09e] kind 的 CHECK 照 CT-24n rights_import_kind：枚举外的值 23514', async () => {
  await requireTable(app, IMPORTS);
  await expectCheckLists(IMPORTS, 'kind', RIGHTS_IMPORT_KIND);
  for (const kind of ['RIGHTS', 'violation', 'blocklist']) {
    expect(await addImport(await rightsImport({ kind })), kind).toBe('23514');
  }
});

it('[B1-09e] time_basis 的 CHECK 照 CT-24n rights_import_time_basis：枚举外的值 23514', async () => {
  await requireTable(app, IMPORTS);
  await expectCheckLists(IMPORTS, 'time_basis', RIGHTS_IMPORT_TIME_BASIS);
  for (const basis of ['created', 'PAID', 'settled']) {
    expect(await addImport(await rightsImport({ time_basis: basis })), basis).toBe('23514');
  }
});

it('[B1-09e] rights_imports.status 的 CHECK 照 CT-24n rights_import_status：枚举值都能写，枚举外 23514', async () => {
  await requireTable(app, IMPORTS);
  await expectCheckLists(IMPORTS, 'status', RIGHTS_IMPORT_STATUS);
  for (const status of RIGHTS_IMPORT_STATUS) {
    expect(await addImport(await rightsImport({ status })), status).toBe('no error');
  }
  for (const status of ['cancelled', 'DONE', 'open']) {
    expect(await addImport(await rightsImport({ status })), status).toBe('23514');
  }
});

it('[B1-09e] 渠道单的联盟账号引用 union_accounts，不存在的账号 23503', async () => {
  await requireTable(app, IMPORTS);
  await expectForeignKey(IMPORTS, 'union_account_id', 'union_accounts');
  expect(await addImport(await channelImport({ union_account_id: randomUUID() }))).toBe('23503');
  expect(await addImport(await channelImport({ union_account_id: await newAccount() }))).toBe(
    'no error',
  );
});

it('[B1-09e] 失败明细引用导入任务（不级联），不存在的 import_id 23503', async () => {
  await requireTable(app, FAILURES);
  await expectForeignKey(FAILURES, 'import_id', IMPORTS);
  expect(await addFailure(randomUUID(), {})).toBe('23503');
});

it('[B1-09e] 失败明细 (import_id, row_no) 唯一：同任务同行号再写 23505，换行号或换任务可写', async () => {
  await requireTable(app, FAILURES);
  const keys = await uniqueIndexesOn(app, FAILURES, ['import_id', 'row_no']);
  expect(keys.filter((k) => k.predicate === null).length, 'non-partial key').toBeGreaterThan(0);
  const first = await newImport();
  const second = await newImport();
  expect(await addFailure(first, { row_no: 7 })).toBe('no error');
  expect(await addFailure(first, { row_no: 7, reason: 'invalid_row' })).toBe('23505');
  expect(await addFailure(first, { row_no: 8 })).toBe('no error');
  expect(await addFailure(second, { row_no: 7 })).toBe('no error');
});

it('[B1-09e] 失败明细 reason 的 CHECK 照 CT-24n rights_import_failure_reason：枚举值都能写，枚举外 23514', async () => {
  await requireTable(app, FAILURES);
  await expectCheckLists(FAILURES, 'reason', RIGHTS_IMPORT_FAILURE_REASON);
  const id = await newImport();
  let row = 100;
  for (const reason of RIGHTS_IMPORT_FAILURE_REASON) {
    row += 1;
    expect(await addFailure(id, { row_no: row, reason }), reason).toBe('no error');
  }
  // duplicate / out-of-window rows are counted on the task, never failure reasons (BR-FUND-06).
  for (const reason of ['duplicate', 'skipped', 'ORDER_NOT_FOUND', 'other']) {
    row += 1;
    expect(await addFailure(id, { row_no: row, reason }), reason).toBe('23514');
  }
});
