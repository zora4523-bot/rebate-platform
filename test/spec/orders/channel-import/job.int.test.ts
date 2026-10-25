// 渠道单经 rights_import 任务逐行处理（B1-09g 的任务 + 本任务的渠道单处理器）：五项计数与逐行失败按处理器
// 的结果；start_at 都是任务受理时刻；崩溃重投（处理器已写名单、该行检查点未提交时 worker 死掉）后名单只一条、
// 该行只计一次（任务书补充：处理器在检查点同一事务里写名单，B1-09g money S2）。上传与任务行用 B1-09g 的
// 夹具（真实 createRightsImport），列模板是合成的（K-3 之前没有真实模板）。用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createChannelImportProcessor } from '../../../../apps/api/src/modules/orders/application/channel-import.ts';
import type {
  RightsImportRowProcessor,
  RightsImportTemplate,
} from '../../../../apps/api/src/modules/orders/application/rights-import-ports.ts';
import { handleRightsImport } from '../../../../apps/api/src/modules/orders/jobs/rights-import.ts';
import { fixture, open, type Fixture, type Harness } from '../rights-import-task/db-kit.ts';
import { received, templates, upload, xlsx } from '../rights-import-task/kit.ts';
import {
  END_AT,
  END_TEXT,
  OTHER_RELATION,
  RELATION,
  THIRD_RELATION,
  at,
  channelDeps,
  entriesOf,
  type BlocklistRow,
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

/** 合成表头：模板列名 relation_id / end_at → 文件里的表头文字。 */
const HEADER = ['渠道关系ID（合成）', '结束时间（合成）'] as const;
const CHANNEL_TEMPLATE: RightsImportTemplate = {
  columns: { relation_id: HEADER[0], end_at: HEADER[1] },
};
/** 受理之后过多久才处理（处理时刻不进 start_at）。 */
const LATER_MS = 5 * 60_000;
const CRASH = 'synthetic worker crash after the row was written';

/** An accepted channel upload of `rows` under the synthetic header, processed LATER_MS after. */
async function channelTask(
  f: Fixture,
  rows: readonly (readonly (string | null)[])[],
  accountId: string = f.accountId,
) {
  const { importId, send } = await f.accepted({
    kind: 'channel',
    platform: 'taobao',
    union_account_id: accountId,
    file: upload(xlsx([HEADER, ...rows])),
  });
  const createdAt = f.clock.now();
  f.clock.advanceMs(LATER_MS);
  const { deps } = channelDeps(f.db, f.clock);
  const registry = templates([['channel', 'taobao']], CHANNEL_TEMPLATE);
  return { importId, send, createdAt, deps, jobDeps: { ...f.jobDeps, templates: registry } };
}

const byValue = (rows: readonly BlocklistRow[]) =>
  [...rows].sort((a, b) => (a.value ?? '').localeCompare(b.value ?? ''));

it('[AC-B1-09h#7] 整份渠道单：成功、同文件重复、格式错分别计数，逐行失败 invalid_row，名单 start_at 都是受理时刻', async () => {
  const f = await fixture(h);
  const t = await channelTask(f, [
    [RELATION, null],
    [OTHER_RELATION, END_TEXT],
    [RELATION, END_TEXT],
    [null, END_TEXT],
    [THIRD_RELATION, 'not-a-time'],
  ]);
  const processor = createChannelImportProcessor(t.deps);
  await handleRightsImport(received(t.send), { ...t.jobDeps, processors: { channel: processor } });
  expect(await f.task(t.importId)).toMatchObject({
    status: 'done',
    total_rows: 5,
    succeeded_rows: 2,
    failed_rows: 2,
    skipped_rows: 0,
    duplicate_rows: 1,
  });
  expect(await f.failures(t.importId)).toEqual([
    { row_no: 5, reason: 'invalid_row' },
    { row_no: 6, reason: 'invalid_row' },
  ]);
  const entries = byValue(await entriesOf(f.db, f.appId));
  expect(entries.map((e) => [e.value, e.union_account_id, e.start_at, e.end_at])).toEqual([
    [RELATION, f.accountId, t.createdAt, null],
    [OTHER_RELATION, f.accountId, t.createdAt, at(END_AT)],
  ]);
  expect(entries.every((e) => e.dimension === 'channel' && e.created_by === f.adminId)).toBe(true);
  expect(f.lines.join('\n')).not.toContain(RELATION);
});

it('[AC-B1-09h#7] 任务账号属 jd、任务 platform 为 taobao：每行 platform_mismatch，不写名单', async () => {
  const f = await fixture(h);
  const jd = await f.account('jd');
  const t = await channelTask(
    f,
    [
      [RELATION, null],
      [OTHER_RELATION, END_TEXT],
    ],
    jd,
  );
  const processor = createChannelImportProcessor(t.deps);
  await handleRightsImport(received(t.send), { ...t.jobDeps, processors: { channel: processor } });
  expect(await f.task(t.importId)).toMatchObject({
    status: 'done',
    total_rows: 2,
    succeeded_rows: 0,
    failed_rows: 2,
    duplicate_rows: 0,
  });
  expect(await f.failures(t.importId)).toEqual([
    { row_no: 2, reason: 'platform_mismatch' },
    { row_no: 3, reason: 'platform_mismatch' },
  ]);
  expect(await entriesOf(f.db, f.appId)).toEqual([]);
});

it('[AC-B1-09h#5] 已写名单、该行检查点未提交时崩溃，重投同一行：名单只一条，该行只计一次（不计 duplicate）', async () => {
  const f = await fixture(h);
  const t = await channelTask(f, [
    [RELATION, null],
    [OTHER_RELATION, END_TEXT],
    [THIRD_RELATION, null],
  ]);
  const real = createChannelImportProcessor(t.deps);
  const sentRows: number[] = [];
  let armed = true;
  // 真实处理器写完名单之后、任务提交这一行的检查点之前，worker 死掉（第一次到第 3 行时）。
  const crashing: RightsImportRowProcessor = {
    async process(task, row, trx) {
      sentRows.push(row.row_no);
      const outcome = await real.process(task, row, trx);
      if (armed && row.row_no === 3) {
        armed = false;
        throw new Error(CRASH);
      }
      return outcome;
    },
  };
  const deps = { ...t.jobDeps, processors: { channel: crashing } };

  await expect(handleRightsImport(received(t.send, 1), deps)).rejects.toThrow(CRASH);
  expect(await f.task(t.importId)).toMatchObject({
    status: 'running',
    total_rows: 1,
    succeeded_rows: 1,
    duplicate_rows: 0,
  });
  expect((await entriesOf(f.db, f.appId)).map((e) => e.value)).toEqual([RELATION]);

  f.clock.advanceMs(LATER_MS);
  await handleRightsImport(received(t.send, 2), deps);
  expect(sentRows).toEqual([2, 3, 3, 4]);
  expect(await f.task(t.importId)).toMatchObject({
    status: 'done',
    total_rows: 3,
    succeeded_rows: 3,
    failed_rows: 0,
    skipped_rows: 0,
    duplicate_rows: 0,
  });
  expect(await f.failures(t.importId)).toEqual([]);
  const entries = byValue(await entriesOf(f.db, f.appId));
  expect(entries.map((e) => [e.value, e.start_at, e.end_at])).toEqual([
    [RELATION, t.createdAt, null],
    [OTHER_RELATION, t.createdAt, at(END_AT)],
    [THIRD_RELATION, t.createdAt, null],
  ]);
});

it('[AC-B1-09h#5] done 的渠道单再投递一次：不再处理，名单与计数不变', async () => {
  const f = await fixture(h);
  const t = await channelTask(f, [[RELATION, null]]);
  const processor = createChannelImportProcessor(t.deps);
  const deps = { ...t.jobDeps, processors: { channel: processor } };
  await handleRightsImport(received(t.send, 1), deps);
  const before = { task: await f.task(t.importId), entries: await entriesOf(f.db, f.appId) };
  expect(before.entries).toHaveLength(1);
  await handleRightsImport(received(t.send, 2), deps);
  expect({ task: await f.task(t.importId), entries: await entriesOf(f.db, f.appId) }).toEqual(
    before,
  );
});
