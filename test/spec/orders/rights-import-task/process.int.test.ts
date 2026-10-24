// rights_import 任务处理（handleRightsImport）：按 kind 分派到逐行处理器；queued → running → done / failed；
// 五项计数；逐行失败只插入 rights_import_failures 且详情返回；登记表没有模板或缺列时逐行 invalid_row；
// 整份失败（文件不在、该 kind 没有处理器）→ failed；重复投递不重复处理；running 中途崩溃后重投从未提交的
// 行接着做、收敛到与一次做完相同的结果。用例全部是顶层 it（资金 / 归属测试路径，规划/11 §4.3）。
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  RightsImportProcessors,
  RightsImportRowProcessor,
} from '../../../../apps/api/src/modules/orders/application/rights-import-ports.ts';
import type {
  RightsImportKind,
  RightsImportRowOutcome,
} from '../../../../apps/api/src/modules/orders/domain/rights-import.ts';
import { handleRightsImport } from '../../../../apps/api/src/modules/orders/jobs/rights-import.ts';
import { ADMIN_NAME, fixture, newAppId, open, type Fixture, type Harness } from './db-kit.ts';
import {
  HEADER,
  PRIVATE_CELL,
  conforms,
  fakeProcessors,
  ms,
  outcomeOf,
  received,
  sheet,
  upload,
} from './kit.ts';

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

const LATER_MS = 90_000;
const MIXED = [
  'succeeded',
  'failed:order_not_found',
  'skipped',
  'duplicate',
  'succeeded',
  'failed:platform_mismatch',
];
const CRASH = 'synthetic worker crash';

function formOf(f: Fixture, kind: RightsImportKind) {
  return kind === 'channel'
    ? { kind, platform: 'taobao', union_account_id: f.accountId }
    : { kind, platform: 'taobao' };
}

/**
 * A rights processor that keeps its own state across attempts, as the real one does in order_rights:
 * a sub-order it has already imported answers duplicate (BR-FUND-06 key); the first time it reaches
 * row `crashAt` it throws before importing anything (the worker dies in the middle of the file).
 */
function crashingOnce(crashAt: number) {
  const imported = new Set<string>();
  const sentRows: number[] = [];
  const duplicate: RightsImportRowOutcome = { kind: 'duplicate' };
  let armed = true;
  const rights: RightsImportRowProcessor = {
    process(_task, row) {
      sentRows.push(row.row_no);
      const subOrder = String(row.values['sub_order_id']);
      if (imported.has(subOrder)) return Promise.resolve(duplicate);
      if (armed && row.row_no === crashAt) {
        armed = false;
        return Promise.reject(new Error(CRASH));
      }
      const outcome = outcomeOf(row.values['expect']);
      if (outcome.kind === 'succeeded') imported.add(subOrder);
      return Promise.resolve(outcome);
    },
  };
  const processors: RightsImportProcessors = { rights };
  return { processors, sentRows };
}

// ---------------------------------------------------------------- 按 kind 分派逐行处理器

it.each(['rights', 'punish', 'channel'] as const)(
  '[AC-B1-09g#11] %s：只交给该 kind 的处理器，逐行按文件顺序，行号同文件（表头为第 1 行），列按登记模板映射',
  async (kind) => {
    const f = await fixture(h);
    const { importId, send } = await f.accepted({
      ...formOf(f, kind),
      file: upload(sheet(['succeeded', 'skipped'])),
    });
    await f.run(send);
    expect(f.rows.calls.map((c) => c.kind)).toEqual([kind, kind]);
    expect(f.rows.calls.map((c) => c.row)).toEqual([
      { row_no: 2, values: { sub_order_id: 'SUB-1', expect: 'succeeded' } },
      { row_no: 3, values: { sub_order_id: 'SUB-2', expect: 'skipped' } },
    ]);
    const task = f.rows.calls[0]!.task;
    expect(task).toMatchObject({
      import_id: importId,
      app_id: f.appId,
      kind,
      platform: 'taobao',
      union_account_id: kind === 'channel' ? f.accountId : null,
      time_basis: null,
      from: null,
      to: null,
      created_by: f.adminId,
    });
    expect(ms(task.created_at)).toBe(f.clock.now().getTime());
    expect(f.registry.find).toHaveBeenCalledWith(kind, 'taobao');
  },
);

it('[AC-B1-09g#11] 时间窗随任务交给处理器（筛行由处理器做）', async () => {
  const f = await fixture(h);
  const from = '2026-10-01T00:00:00+08:00';
  const to = '2026-11-01T00:00:00+08:00';
  const { send } = await f.accepted({ kind: 'rights', time_basis: 'paid', from, to });
  await f.run(send);
  const task = f.rows.calls[0]!.task;
  expect(task.time_basis).toBe('paid');
  expect(ms(task.from)).toBe(new Date(from).getTime());
  expect(ms(task.to)).toBe(new Date(to).getTime());
});

// ---------------------------------------------------------------- 状态与五项计数

it('[AC-B1-09g#12] 处理行时任务已是 running；结束为 done，五项计数、finished_at 为结束时刻', async () => {
  const f = await fixture(h);
  const { importId, send } = await f.accepted({ file: upload(sheet(MIXED)) });
  expect((await f.task(importId))?.status).toBe('queued');
  const seen: (string | undefined)[] = [];
  const watched = fakeProcessors(['rights'], async (call) => {
    seen.push((await f.task(call.task.import_id))?.status);
  });
  f.clock.advanceMs(LATER_MS);
  await f.run(send, { processors: watched.processors });
  expect(seen).toEqual(MIXED.map(() => 'running'));
  const row = await f.task(importId);
  expect(row).toMatchObject({
    status: 'done',
    total_rows: 6,
    succeeded_rows: 2,
    failed_rows: 2,
    skipped_rows: 1,
    duplicate_rows: 1,
  });
  expect(ms(row?.finished_at)).toBe(f.clock.now().getTime());
  expect(await f.failures(importId)).toEqual([
    { row_no: 3, reason: 'order_not_found' },
    { row_no: 7, reason: 'platform_mismatch' },
  ]);
});

it('[AC-B1-09g#12] 详情返回五项计数与全部逐行失败（按 row_no）', async () => {
  const f = await fixture(h);
  const { importId, send } = await f.accepted({
    kind: 'punish',
    platform: 'taobao',
    file: upload(sheet(['failed:received_at_missing', ...MIXED, 'failed:sub_order_no_missing'])),
  });
  const createdAt = f.clock.now().getTime();
  f.clock.advanceMs(LATER_MS);
  await f.run(send);
  const result = await f.detail(importId);
  expect(result).toMatchObject({
    code: 0,
    data: {
      import_id: importId,
      kind: 'punish',
      platform: 'taobao',
      status: 'done',
      total_rows: 8,
      succeeded_rows: 2,
      failed_rows: 4,
      skipped_rows: 1,
      duplicate_rows: 1,
      created_by: f.adminId,
      created_by_name: ADMIN_NAME,
      failures: [
        { row_no: 2, reason: 'received_at_missing' },
        { row_no: 4, reason: 'order_not_found' },
        { row_no: 8, reason: 'platform_mismatch' },
        { row_no: 9, reason: 'sub_order_no_missing' },
      ],
    },
  });
  await conforms(result.data, 'AdminRightsImportDetail');
  const data = result.data as { created_at: string; finished_at: string | null };
  expect(ms(data.created_at)).toBe(createdAt);
  expect(ms(data.finished_at)).toBe(f.clock.now().getTime());
});

it('[AC-B1-09g#12] 全部成功：failures 为空', async () => {
  const f = await fixture(h);
  const { importId, send } = await f.accepted({
    file: upload(sheet(['succeeded', 'succeeded'])),
  });
  await f.run(send);
  expect(await f.failures(importId)).toEqual([]);
  expect(await f.detail(importId)).toMatchObject({
    code: 0,
    data: { status: 'done', total_rows: 2, succeeded_rows: 2, failed_rows: 0, failures: [] },
  });
});

it('[AC-B1-09g#12] 处理与日志都不带文件内容', async () => {
  const f = await fixture(h);
  const { send } = await f.accepted({ file: upload(sheet(MIXED)) });
  await f.run(send);
  expect(f.lines.join('\n')).not.toContain(PRIVATE_CELL);
});

// ---------------------------------------------------------------- 列映射读登记表（表头模板待负责人样例）

it.each(['rights', 'punish'] as const)(
  '[AC-B1-09g#13] %s：登记表没有 (kind, platform) 的模板 → 每行 invalid_row，处理器不被调用',
  async (kind) => {
    const f = await fixture(h);
    const { importId, send } = await f.accepted({
      kind,
      platform: 'jd',
      file: upload(sheet(['succeeded', 'skipped', 'duplicate'])),
    });
    await f.run(send);
    expect(f.registry.find).toHaveBeenCalledWith(kind, 'jd');
    expect(f.rows.calls).toEqual([]);
    expect(await f.task(importId)).toMatchObject({
      status: 'done',
      total_rows: 3,
      succeeded_rows: 0,
      failed_rows: 3,
      skipped_rows: 0,
      duplicate_rows: 0,
    });
    expect(await f.failures(importId)).toEqual([
      { row_no: 2, reason: 'invalid_row' },
      { row_no: 3, reason: 'invalid_row' },
      { row_no: 4, reason: 'invalid_row' },
    ]);
  },
);

it('[AC-B1-09g#13] 表头缺模板的列 → 每行 invalid_row，处理器不被调用', async () => {
  const f = await fixture(h);
  const header = [HEADER[0], HEADER[2]];
  const { importId, send } = await f.accepted({
    file: upload(sheet(['succeeded', 'succeeded'], header)),
  });
  await f.run(send);
  expect(f.rows.calls).toEqual([]);
  expect(await f.task(importId)).toMatchObject({
    status: 'done',
    total_rows: 2,
    failed_rows: 2,
  });
  expect(await f.failures(importId)).toEqual([
    { row_no: 2, reason: 'invalid_row' },
    { row_no: 3, reason: 'invalid_row' },
  ]);
});

// ---------------------------------------------------------------- 整份失败 → failed

it('[AC-B1-09g#14] 该 kind 没有注入处理器：任务 failed、有 finished_at，不处理任何行', async () => {
  const f = await fixture(h);
  const only = fakeProcessors(['rights']);
  const { importId, send } = await f.accepted({
    kind: 'punish',
    file: upload(sheet(['succeeded'])),
  });
  f.clock.advanceMs(LATER_MS);
  await f.run(send, { processors: only.processors });
  expect(only.calls).toEqual([]);
  const row = await f.task(importId);
  expect(row).toMatchObject({ status: 'failed', succeeded_rows: 0, failed_rows: 0 });
  expect(ms(row?.finished_at)).toBe(f.clock.now().getTime());
  expect(await f.failures(importId)).toEqual([]);
  expect(await f.detail(importId)).toMatchObject({
    code: 0,
    data: { status: 'failed', failures: [] },
  });
});

it('[AC-B1-09g#14] 导入存储里已没有该文件：任务 failed，不处理任何行', async () => {
  const f = await fixture(h);
  const { importId, send } = await f.accepted({ file: upload(sheet(['succeeded'])) });
  await f.memory.delete((await f.task(importId))!.file_path);
  await f.run(send);
  expect(f.rows.calls).toEqual([]);
  const row = await f.task(importId);
  expect(row?.status).toBe('failed');
  expect(ms(row?.finished_at)).toBe(f.clock.now().getTime());
});

// ---------------------------------------------------------------- 至少一次投递

it('[AC-B1-09g#15] done 的任务再投递一次：不再处理，计数与失败明细不变', async () => {
  const f = await fixture(h);
  const { importId, send } = await f.accepted({ file: upload(sheet(MIXED)) });
  await f.run(send);
  const before = { row: await f.task(importId), failures: await f.failures(importId) };
  const calls = f.rows.calls.length;
  await f.run(send);
  expect(f.rows.calls).toHaveLength(calls);
  expect(calls).toBe(MIXED.length);
  expect({ row: await f.task(importId), failures: await f.failures(importId) }).toEqual(before);
});

it('[AC-B1-09g#15] 载荷指向不存在的任务或别的 App：什么都不做', async () => {
  const f = await fixture(h);
  const { importId, send } = await f.accepted({ file: upload(sheet(['succeeded'])) });
  for (const payload of [
    { app_id: f.appId, import_id: randomUUID() },
    { app_id: newAppId(), import_id: importId },
  ]) {
    await handleRightsImport({ ...received(send), payload }, f.jobDeps);
  }
  expect(f.rows.calls).toEqual([]);
  expect(await f.task(importId)).toMatchObject({ status: 'queued', finished_at: null });
});

// 幂等口径：处理器抛出的异常不吞（本次投递失败、任务留在 running，由队列重投）；每行的结果（失败明细与
// 计数）在下一行交给处理器之前提交；重投时任务仍是 running → 从第一个未提交的行接着做，已提交的行不再
// 交给处理器（不撞 (import_id, row_no) 主键、本任务已导入的行不被处理器的去重键计成 duplicate），
// 崩溃时在处理中的那一行重做；最终状态、五项计数与失败明细与一次做完相同。
it('[AC-B1-09g#15] running 中途崩溃（已写部分失败明细）后重投：接着做完，结果与一次做完相同', async () => {
  const f = await fixture(h);
  const { importId, send } = await f.accepted({ file: upload(sheet(MIXED)) });
  const worker = crashingOnce(5);
  const deps = { ...f.jobDeps, processors: worker.processors };

  await expect(handleRightsImport(received(send, 1), deps)).rejects.toThrow(CRASH);
  expect(await f.task(importId)).toMatchObject({ status: 'running', finished_at: null });
  expect(await f.failures(importId)).toEqual([{ row_no: 3, reason: 'order_not_found' }]);

  f.clock.advanceMs(LATER_MS);
  await handleRightsImport(received(send, 2), deps);
  expect(worker.sentRows).toEqual([2, 3, 4, 5, 5, 6, 7]);
  const row = await f.task(importId);
  expect(row).toMatchObject({
    status: 'done',
    total_rows: 6,
    succeeded_rows: 2,
    failed_rows: 2,
    skipped_rows: 1,
    duplicate_rows: 1,
  });
  expect(ms(row?.finished_at)).toBe(f.clock.now().getTime());
  expect(await f.failures(importId)).toEqual([
    { row_no: 3, reason: 'order_not_found' },
    { row_no: 7, reason: 'platform_mismatch' },
  ]);
  expect(f.lines.join('\n')).not.toContain(PRIVATE_CELL);
});
