// 维权单 / 违规单经 rights_import 任务逐行处理（B1-09g 的任务 + 本任务的处理器）：五项计数与逐行失败按处理器
// 的结果；同一文件再上传一次，已导入的行计 duplicate_rows（不算 skipped、不算失败、不重复写）；处理器在检查点
// 同一事务里写，崩溃重投后该行只计一次；rights.record 未注入时任务记 failed 并告警、不写 order_rights
// （J-22）。上传与任务行用 B1-09g 的夹具（真实 createRightsImport），列模板是合成的（K-3 之前没有真实模板）。
// 用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  RightsImportRowProcessor,
  RightsImportTemplate,
} from '../../../../apps/api/src/modules/orders/application/rights-import-ports.ts';
import { createRightsImportProcessors } from '../../../../apps/api/src/modules/orders/application/rights-import-rows.ts';
import type { OrderRightsPorts } from '../../../../apps/api/src/modules/orders/application/rights-ports.ts';
import { handleRightsImport } from '../../../../apps/api/src/modules/orders/jobs/rights-import.ts';
import { fixture, open, type Fixture, type Harness } from '../rights-import-task/db-kit.ts';
import { received, templates } from '../rights-import-task/kit.ts';
import {
  FROM_TEXT,
  OCCURRED_AT,
  OTHER_RIGHTS_NO,
  PAID_IN,
  PAID_OUT,
  PUNISH_COLUMNS,
  PUNISH_TEMPLATE,
  RIGHTS_COLUMNS,
  RIGHTS_NO,
  RIGHTS_TEMPLATE,
  TO_TEXT,
  at,
  fakeSettlement,
  fileOf,
  orderNo,
  rightsOf,
  rightsView,
  seedOrder,
} from './db-kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

const CRASH = 'synthetic worker crash after the row was written';
const PAID_WINDOW = { time_basis: 'paid', from: FROM_TEXT, to: TO_TEXT } as const;

type Line = Partial<Record<keyof typeof RIGHTS_COLUMNS, string | null>>;

/** A full rights line of the synthetic template for `sub` (overrides in `patch`). */
const line = (sub: string | null, patch: Line = {}): Line => ({
  sub_order_id: sub,
  platform: 'taobao',
  rights_no: RIGHTS_NO,
  status: 'SUCCEEDED',
  amount: '12.30',
  deduction_commission: '1.23',
  occurred_at: '2026-10-18 10:30:00',
  ...patch,
});

/** An accepted upload of `kind` and the job deps with the synthetic template and `ports`. */
async function importTask(
  f: Fixture,
  kind: 'rights' | 'punish',
  lines: readonly Line[],
  options: { window?: boolean } = {},
) {
  const template: RightsImportTemplate = kind === 'rights' ? RIGHTS_TEMPLATE : PUNISH_TEMPLATE;
  const columns = kind === 'rights' ? RIGHTS_COLUMNS : PUNISH_COLUMNS;
  const { importId, send } = await f.accepted({
    kind,
    platform: 'taobao',
    ...(options.window === true ? PAID_WINDOW : {}),
    file: fileOf(columns, lines),
  });
  const registry = templates([[kind, 'taobao']], template);
  return { importId, send, jobDeps: { ...f.jobDeps, templates: registry } };
}

function processorsOf(f: Fixture, ports: OrderRightsPorts | undefined) {
  return createRightsImportProcessors({ db: f.db, clock: f.clock, ports });
}

const errorEvents = (f: Fixture) =>
  f.lines
    .map((l) => JSON.parse(l) as { level?: number; event?: string })
    .filter((l) => l.level === 50)
    .map((l) => l.event);

it('[AC-B1-09k#3] 整份维权单（付款口径时间窗）：成功、窗外、四类失败分别计数，逐行失败按行号记原因，只写成功的行', async () => {
  const f = await fixture(h);
  const s = fakeSettlement(f.db);
  const a = await seedOrder(f.db, f.appId, { paid_at: at(PAID_IN) });
  const b = await seedOrder(f.db, f.appId, { paid_at: at(PAID_OUT) });
  const c = await seedOrder(f.db, f.appId, { paid_at: at(PAID_IN) });
  const t = await importTask(
    f,
    'rights',
    [
      line(a.sub_order_id, { status: 'PROCESSING' }),
      line(b.sub_order_id),
      line(null, { parent_order_id: c.parent_order_id }),
      line(orderNo()),
      line(a.sub_order_id, { occurred_at: 'not-a-time' }),
      line(c.sub_order_id, { platform: 'jd' }),
      line(c.sub_order_id, { rights_no: OTHER_RIGHTS_NO }),
    ],
    { window: true },
  );
  await handleRightsImport(received(t.send), {
    ...t.jobDeps,
    processors: processorsOf(f, s.ports),
  });
  expect(await f.task(t.importId)).toMatchObject({
    status: 'done',
    total_rows: 7,
    succeeded_rows: 2,
    failed_rows: 4,
    skipped_rows: 1,
    duplicate_rows: 0,
  });
  expect(await f.failures(t.importId)).toEqual([
    { row_no: 4, reason: 'sub_order_no_missing' },
    { row_no: 5, reason: 'order_not_found' },
    { row_no: 6, reason: 'invalid_row' },
    { row_no: 7, reason: 'platform_mismatch' },
  ]);
  const rights = (await rightsOf(f.db, f.appId)).map(rightsView);
  expect(rights).toEqual(
    expect.arrayContaining([
      {
        order_id: a.order_id,
        source: 'IMPORT',
        type: 'RIGHTS',
        status: 'PROCESSING',
        amount_fen: 1230n,
        deduction_commission_fen: 123n,
        occurred_at: at(OCCURRED_AT),
        platform_rights_no: RIGHTS_NO,
      },
      {
        order_id: c.order_id,
        source: 'IMPORT',
        type: 'RIGHTS',
        status: 'SUCCEEDED',
        amount_fen: 1230n,
        deduction_commission_fen: 123n,
        occurred_at: at(OCCURRED_AT),
        platform_rights_no: OTHER_RIGHTS_NO,
      },
    ]),
  );
  expect(rights).toHaveLength(2);
  const logs = f.lines.join('\n');
  expect(logs).not.toContain(a.sub_order_id);
  expect(logs).not.toContain(c.parent_order_id);
});

it('[AC-B1-09k#2] 整份违规单：每行写 PUNISH / SUCCEEDED，计数与写入一致', async () => {
  const f = await fixture(h);
  const s = fakeSettlement(f.db);
  const a = await seedOrder(f.db, f.appId);
  const b = await seedOrder(f.db, f.appId);
  // 违规单模板没有状态列：line 里的状态不进文件。
  const t = await importTask(f, 'punish', [
    line(a.sub_order_id),
    line(b.sub_order_id, { rights_no: OTHER_RIGHTS_NO }),
  ]);
  await handleRightsImport(received(t.send), {
    ...t.jobDeps,
    processors: processorsOf(f, s.ports),
  });
  expect(await f.task(t.importId)).toMatchObject({
    status: 'done',
    total_rows: 2,
    succeeded_rows: 2,
    failed_rows: 0,
    skipped_rows: 0,
    duplicate_rows: 0,
  });
  const rights = await rightsOf(f.db, f.appId);
  expect(rights.map((r) => [r.order_id, r.type, r.status, r.source]).sort()).toEqual(
    [
      [a.order_id, 'PUNISH', 'SUCCEEDED', 'IMPORT'],
      [b.order_id, 'PUNISH', 'SUCCEEDED', 'IMPORT'],
    ].sort(),
  );
});

it('[AC-B1-09k#5] 同一文件再上传一次：新任务里已导入的行计 duplicate_rows（不算 skipped、不算失败），不重复写', async () => {
  const f = await fixture(h);
  const s = fakeSettlement(f.db);
  const a = await seedOrder(f.db, f.appId, { paid_at: at(PAID_IN) });
  const b = await seedOrder(f.db, f.appId, { paid_at: at(PAID_OUT) });
  const lines = [line(a.sub_order_id), line(b.sub_order_id), line(orderNo())];
  const processors = processorsOf(f, s.ports);

  const first = await importTask(f, 'rights', lines, { window: true });
  await handleRightsImport(received(first.send), { ...first.jobDeps, processors });
  expect(await f.task(first.importId)).toMatchObject({
    status: 'done',
    total_rows: 3,
    succeeded_rows: 1,
    failed_rows: 1,
    skipped_rows: 1,
    duplicate_rows: 0,
  });
  const written = await rightsOf(f.db, f.appId);
  expect(written.map((r) => r.order_id)).toEqual([a.order_id]);

  const second = await importTask(f, 'rights', lines, { window: true });
  expect(second.importId).not.toBe(first.importId);
  await handleRightsImport(received(second.send), { ...second.jobDeps, processors });
  expect(await f.task(second.importId)).toMatchObject({
    status: 'done',
    total_rows: 3,
    succeeded_rows: 0,
    failed_rows: 1,
    skipped_rows: 1,
    duplicate_rows: 1,
  });
  expect(await f.failures(second.importId)).toEqual([{ row_no: 4, reason: 'order_not_found' }]);
  expect(await rightsOf(f.db, f.appId)).toEqual(written);
});

it('[AC-B1-09k#6] 已写维权、该行检查点未提交时崩溃，重投同一行：order_rights 各一条，该行只计一次（不计 duplicate）', async () => {
  const f = await fixture(h);
  const s = fakeSettlement(f.db);
  const orders = [
    await seedOrder(f.db, f.appId),
    await seedOrder(f.db, f.appId),
    await seedOrder(f.db, f.appId),
  ];
  const t = await importTask(
    f,
    'rights',
    orders.map((o) => line(o.sub_order_id)),
  );
  const real = processorsOf(f, s.ports).rights;
  expect(real, 'a rights processor').toBeDefined();
  const sentRows: number[] = [];
  const handed: boolean[] = [];
  let armed = true;
  // 真实处理器在交给它的事务里写完第 3 行之后、任务提交这一行的检查点之前，worker 死掉（只在第一次到第 3 行时）。
  const crashing: RightsImportRowProcessor = {
    async process(task, row, trx) {
      sentRows.push(row.row_no);
      handed.push(trx !== undefined);
      const outcome = await real!.process(task, row, trx);
      if (armed && row.row_no === 3) {
        armed = false;
        throw new Error(CRASH);
      }
      return outcome;
    },
  };
  const deps = { ...t.jobDeps, processors: { rights: crashing } };

  await expect(handleRightsImport(received(t.send, 1), deps)).rejects.toThrow(CRASH);
  expect(await f.task(t.importId)).toMatchObject({
    status: 'running',
    total_rows: 1,
    succeeded_rows: 1,
    duplicate_rows: 0,
  });
  expect((await rightsOf(f.db, f.appId)).map((r) => r.order_id)).toEqual([orders[0]!.order_id]);

  await handleRightsImport(received(t.send, 2), deps);
  expect(sentRows).toEqual([2, 3, 3, 4]);
  expect(handed.every(Boolean)).toBe(true);
  expect(await f.task(t.importId)).toMatchObject({
    status: 'done',
    total_rows: 3,
    succeeded_rows: 3,
    failed_rows: 0,
    skipped_rows: 0,
    duplicate_rows: 0,
  });
  expect(await f.failures(t.importId)).toEqual([]);
  const written = (await rightsOf(f.db, f.appId)).map((r) => r.order_id).sort();
  expect(written).toEqual(orders.map((o) => o.order_id).sort());
});

it('[AC-B1-09k#7] rights.record 未注入（端口整体缺失）：维权单任务记 failed 并告警，不处理任何行、不写 order_rights', async () => {
  const f = await fixture(h);
  const a = await seedOrder(f.db, f.appId);
  const t = await importTask(f, 'rights', [line(a.sub_order_id)]);
  await handleRightsImport(received(t.send), {
    ...t.jobDeps,
    processors: processorsOf(f, undefined),
  });
  const task = await f.task(t.importId);
  expect(task).toMatchObject({
    status: 'failed',
    total_rows: 0,
    succeeded_rows: 0,
    failed_rows: 0,
    skipped_rows: 0,
    duplicate_rows: 0,
  });
  expect(task?.finished_at).toEqual(f.clock.now());
  expect(await f.failures(t.importId)).toEqual([]);
  expect(await rightsOf(f.db, f.appId)).toEqual([]);
  expect(errorEvents(f)).toContain('rights_import_failed');
});

it('[AC-B1-09k#7] rights.record 未注入（ports 里没有 rights）：违规单任务同样记 failed 并告警、不写', async () => {
  const f = await fixture(h);
  const a = await seedOrder(f.db, f.appId);
  const t = await importTask(f, 'punish', [line(a.sub_order_id)]);
  await handleRightsImport(received(t.send), {
    ...t.jobDeps,
    processors: processorsOf(f, {}),
  });
  expect(await f.task(t.importId)).toMatchObject({ status: 'failed', total_rows: 0 });
  expect(await f.failures(t.importId)).toEqual([]);
  expect(await rightsOf(f.db, f.appId)).toEqual([]);
  expect(errorEvents(f)).toContain('rights_import_failed');
});
