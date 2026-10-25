// 渠道单名单与该行检查点同一事务（任务书补充：B1-09g money S2；规则测试评审 r1 S1）：处理器在任务交给它的
// 那一行的事务里写名单，任务在同一事务里提交该行检查点。区分「同一事务」与「处理器另开事务先提交名单、
// 再另开事务提交检查点」：① 处理器写完名单返回之后，这一行的事务再也提交不了（模拟 worker 在 COMMIT 之前
// 死掉）→ 名单与检查点都不留，重投后该行只计一次；② 处理器拿到的事务号就是提交该行检查点的事务号（下一行
// 处理时，任务行已提交版本的 xmin）。上传与任务行用 B1-09g 的夹具（真实 createRightsImport），列模板是
// 合成的（K-3 之前没有真实模板）。用例全部是顶层 it（规划/11 §4.3）。
import type { DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Transaction } from 'kysely';
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
const LATER_MS = 5 * 60_000;
const CRASH = 'synthetic worker death before the row transaction commits';
const RAISE_CRASH = sql`DO $$ BEGIN RAISE EXCEPTION '${sql.raw(CRASH)}'; END $$`;

async function channelTask(f: Fixture, rows: readonly (readonly (string | null)[])[]) {
  const { importId, send } = await f.accepted({
    kind: 'channel',
    platform: 'taobao',
    union_account_id: f.accountId,
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

/**
 * Leaves `trx` unable to commit: a statement fails on it, so every later statement on it fails and
 * its COMMIT only rolls back — what a worker dying before COMMIT leaves of that transaction.
 */
async function doom(trx: Transaction<DB>): Promise<void> {
  await expect(RAISE_CRASH.execute(trx)).rejects.toThrow(CRASH);
}

/** The low 32 bits of the current transaction id: comparable with a row version's xmin. */
async function txidOn(trx: Transaction<DB>): Promise<string> {
  const query = sql<{ id: string }>`SELECT (txid_current() % 4294967296)::text AS id`;
  const { rows } = await query.execute(trx);
  return rows[0]!.id;
}

it('[AC-B1-09h#5] 名单写完、该行事务提交不了（COMMIT 前死掉）：名单与检查点都不留；重投后名单各一条、该行只计一次', async () => {
  const f = await fixture(h);
  const t = await channelTask(f, [
    [RELATION, null],
    [OTHER_RELATION, END_TEXT],
    [THIRD_RELATION, null],
  ]);
  const real = createChannelImportProcessor(t.deps);
  const sentRows: number[] = [];
  const handed: boolean[] = [];
  let armed = true;
  // 真实处理器在交给它的事务里写完第 3 行的名单并返回之后，这一事务再也提交不了（只在第一次到第 3 行时）。
  const dying: RightsImportRowProcessor = {
    async process(task, row, trx) {
      sentRows.push(row.row_no);
      handed.push(trx !== undefined);
      const outcome = await real.process(task, row, trx);
      if (armed && row.row_no === 3 && trx !== undefined) {
        armed = false;
        await doom(trx);
      }
      return outcome;
    },
  };
  const deps = { ...t.jobDeps, processors: { channel: dying } };

  // 同一事务：检查点的语句跑在这一事务上而失败，本次尝试失败，队列重投。
  await expect(handleRightsImport(received(t.send, 1), deps)).rejects.toThrow();
  expect(handed, 'every row is handed its checkpoint transaction').toEqual([true, true]);
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
  const entries = byValue(await entriesOf(f.db, f.appId));
  expect(entries.map((e) => [e.value, e.start_at, e.end_at])).toEqual([
    [RELATION, t.createdAt, null],
    [OTHER_RELATION, t.createdAt, at(END_AT)],
    [THIRD_RELATION, t.createdAt, null],
  ]);
});

it('[AC-B1-09h#5] 处理器拿到的事务就是提交该行检查点的事务（成功行、duplicate 行、失败行都是）', async () => {
  const f = await fixture(h);
  const t = await channelTask(f, [
    [RELATION, null],
    [RELATION, END_TEXT],
    [null, END_TEXT],
    [OTHER_RELATION, null],
  ]);
  const real = createChannelImportProcessor(t.deps);
  /** row_no → the transaction the processor was handed for it. */
  const processorTx = new Map<number, string>();
  /** row_no → xmin of the committed task row when that row reached the processor. */
  const committedTx = new Map<number, string>();
  const observing: RightsImportRowProcessor = {
    async process(task, row, trx) {
      expect(trx, `row ${row.row_no} is handed its checkpoint transaction`).toBeDefined();
      // Read on another connection: the version committed by the previous row's checkpoint.
      const { rows } = await sql<{ x: string }>`SELECT xmin::text AS x FROM rights_imports
        WHERE app_id = ${f.appId} AND id = ${t.importId}`.execute(f.db);
      committedTx.set(row.row_no, rows[0]!.x);
      const outcome = await real.process(task, row, trx);
      processorTx.set(row.row_no, await txidOn(trx!));
      return outcome;
    },
  };
  await handleRightsImport(received(t.send), {
    ...t.jobDeps,
    processors: { channel: observing },
  });
  expect(await f.task(t.importId)).toMatchObject({
    status: 'done',
    total_rows: 4,
    succeeded_rows: 2,
    failed_rows: 1,
    duplicate_rows: 1,
  });
  expect(await f.failures(t.importId)).toEqual([{ row_no: 4, reason: 'invalid_row' }]);
  // Rows 2, 3 and 4 (succeeded, duplicate, invalid_row): their checkpoint is what row n + 1 sees.
  for (const rowNo of [2, 3, 4]) {
    expect(processorTx.get(rowNo), `row ${rowNo}`).toBeDefined();
    expect(committedTx.get(rowNo + 1), `checkpoint of row ${rowNo}`).toBe(processorTx.get(rowNo));
  }
  expect(new Set(processorTx.values()).size, 'one transaction per row').toBe(4);
});
