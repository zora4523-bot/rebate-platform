// rights.record 答 not_applicable（规则测试评审 r1 的 S2，编排定）：settlement 什么都没写，这一行计 skipped
// （skipped_rows）——不算成功、不算 duplicate、不记逐行失败，也不抛错让任务重试同一行。BR-FUND-06 没写这一答复，
// 取值按任务书「第 2 次要改的」S2。用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createRightsImportProcessors } from '../../../../apps/api/src/modules/orders/application/rights-import-rows.ts';
import type {
  OrderRightsPorts,
  RightsCommandPort,
} from '../../../../apps/api/src/modules/orders/application/rights-ports.ts';
import { handleRightsImport } from '../../../../apps/api/src/modules/orders/jobs/rights-import.ts';
import { fixture, open, type Harness } from '../rights-import-task/db-kit.ts';
import { received, templates } from '../rights-import-task/kit.ts';
import {
  RIGHTS_COLUMNS,
  RIGHTS_NO,
  RIGHTS_TEMPLATE,
  SKIPPED,
  fakeSettlement,
  fileOf,
  orderNo,
  punishRow,
  rightsOf,
  rightsRow,
  seedOrder,
  setup,
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

const NOT_APPLICABLE = { kind: 'not_applicable' } as const;

it('[AC-B1-09k#5] rights.record 答 not_applicable：维权单、违规单这一行都计 skipped，只调一次、不抛错、不写', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  f.settlement.control.answer = NOT_APPLICABLE;
  expect(await f.run('rights', rightsRow(o.sub_order_id))).toEqual(SKIPPED);
  expect(await f.run('punish', punishRow(o.sub_order_id))).toEqual(SKIPPED);
  expect(f.record).toHaveBeenCalledTimes(2);
  expect(f.calls.map((c) => [c.input.order_id, c.input.type])).toEqual([
    [o.order_id, 'RIGHTS'],
    [o.order_id, 'PUNISH'],
  ]);
  expect(await f.rights()).toEqual([]);
});

it('[AC-B1-09k#5] 交给处理器的事务里答 not_applicable：返回 skipped，事务照常提交（不靠抛错回滚）', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  f.settlement.control.answer = NOT_APPLICABLE;
  const processor = f.processor('rights');
  const task = f.task();
  const outcome = await h.db
    .transaction()
    .execute((trx) => processor.process(task, rightsRow(o.sub_order_id), trx));
  expect(outcome).toEqual(SKIPPED);
  expect(f.record).toHaveBeenCalledTimes(1);
  expect(await f.rights()).toEqual([]);
});

it('[AC-B1-09k#5] 整份维权单里一行答 not_applicable：计入 skipped_rows（不算成功 / duplicate / 失败），任务一次跑完', async () => {
  const f = await fixture(h);
  const s = fakeSettlement(f.db);
  const a = await seedOrder(f.db, f.appId);
  const b = await seedOrder(f.db, f.appId);
  // b 的那一行由 settlement 答 not_applicable（什么都不写），其余照常交给假端口。
  const record = vi.fn<RightsCommandPort['record']>(async (trx, input) =>
    input.order_id === b.order_id ? NOT_APPLICABLE : s.record(trx, input),
  );
  const ports: OrderRightsPorts = { rights: { record } };
  const line = (sub: string) => ({
    sub_order_id: sub,
    platform: 'taobao',
    rights_no: RIGHTS_NO,
    status: 'SUCCEEDED',
    amount: '12.30',
    deduction_commission: '1.23',
    occurred_at: '2026-10-18 10:30:00',
  });
  const { importId, send } = await f.accepted({
    kind: 'rights',
    platform: 'taobao',
    file: fileOf(RIGHTS_COLUMNS, [line(a.sub_order_id), line(b.sub_order_id), line(orderNo())]),
  });
  await handleRightsImport(received(send), {
    ...f.jobDeps,
    templates: templates([['rights', 'taobao']], RIGHTS_TEMPLATE),
    processors: createRightsImportProcessors({ db: f.db, clock: f.clock, ports }),
  });
  expect(await f.task(importId)).toMatchObject({
    status: 'done',
    total_rows: 3,
    succeeded_rows: 1,
    failed_rows: 1,
    skipped_rows: 1,
    duplicate_rows: 0,
  });
  expect(await f.failures(importId)).toEqual([{ row_no: 4, reason: 'order_not_found' }]);
  expect(record.mock.calls.filter(([, input]) => input.order_id === b.order_id)).toHaveLength(1);
  expect((await rightsOf(f.db, f.appId)).map((r) => r.order_id)).toEqual([a.order_id]);
});
