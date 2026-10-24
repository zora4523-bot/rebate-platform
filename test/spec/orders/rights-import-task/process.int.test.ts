// rights_import 任务处理（handleRightsImport）：按 kind 分派到逐行处理器；queued → running → done / failed；
// 五项计数；逐行失败只插入 rights_import_failures 且详情返回；登记表没有模板或缺列时逐行 invalid_row；
// 整份失败（文件不在、该 kind 没有处理器）→ failed；重复投递不重复处理。
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RightsImportKind } from '../../../../apps/api/src/modules/orders/domain/rights-import.ts';
import { handleRightsImport } from '../../../../apps/api/src/modules/orders/jobs/rights-import.ts';
import { ADMIN_NAME, fixture, newAppId, open, type Fixture, type Harness } from './db-kit.ts';
import {
  HEADER,
  PRIVATE_CELL,
  conforms,
  fakeProcessors,
  ms,
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

function formOf(f: Fixture, kind: RightsImportKind) {
  return kind === 'channel'
    ? { kind, platform: 'taobao', union_account_id: f.accountId }
    : { kind, platform: 'taobao' };
}

describe('[AC-B1-09g#11] 按 kind 分派逐行处理器', () => {
  it.each(['rights', 'punish', 'channel'] as const)(
    '%s：只交给该 kind 的处理器，逐行按文件顺序，行号同文件（表头为第 1 行），列按登记模板映射',
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

  it('时间窗随任务交给处理器（筛行由处理器做）', async () => {
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
});

describe('[AC-B1-09g#12] 状态与五项计数', () => {
  it('处理行时任务已是 running；结束为 done，五项计数、finished_at 为结束时刻', async () => {
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

  it('详情返回五项计数与全部逐行失败（按 row_no）', async () => {
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

  it('全部成功：failures 为空', async () => {
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

  it('处理与日志都不带文件内容', async () => {
    const f = await fixture(h);
    const { send } = await f.accepted({ file: upload(sheet(MIXED)) });
    await f.run(send);
    expect(f.lines.join('\n')).not.toContain(PRIVATE_CELL);
  });
});

describe('[AC-B1-09g#13] 列映射读登记表（表头模板待负责人样例）', () => {
  it.each(['rights', 'punish'] as const)(
    '%s：登记表没有 (kind, platform) 的模板 → 每行 invalid_row，处理器不被调用',
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

  it('表头缺模板的列 → 每行 invalid_row，处理器不被调用', async () => {
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
});

describe('[AC-B1-09g#14] 整份失败 → failed', () => {
  it('该 kind 没有注入处理器：任务 failed、有 finished_at，不处理任何行', async () => {
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

  it('导入存储里已没有该文件：任务 failed，不处理任何行', async () => {
    const f = await fixture(h);
    const { importId, send } = await f.accepted({ file: upload(sheet(['succeeded'])) });
    await f.memory.delete((await f.task(importId))!.file_path);
    await f.run(send);
    expect(f.rows.calls).toEqual([]);
    const row = await f.task(importId);
    expect(row?.status).toBe('failed');
    expect(ms(row?.finished_at)).toBe(f.clock.now().getTime());
  });
});

describe('[AC-B1-09g#15] 至少一次投递', () => {
  it('done 的任务再投递一次：不再处理，计数与失败明细不变', async () => {
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

  it('载荷指向不存在的任务或别的 App：什么都不做', async () => {
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
});
