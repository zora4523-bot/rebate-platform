// 上传受理（用例 createRightsImport）：每次上传都是新任务；文件进私有导入存储；整份一条审计；同一事务在
// orders 自有的 order-sync 队列投 rights_import 任务；不合的请求什么都不留下。
// 用例全部是顶层 it（资金 / 归属测试路径，规划/11 §4.3）。
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { IP, fixture, newAppId, open, type Fixture, type Harness } from './db-kit.ts';
import {
  AUDIT_ACTION,
  FILENAME,
  JOB,
  MAX_ROWS,
  PNG,
  PRIVATE_CELL,
  QUEUE,
  conforms,
  fieldsError,
  hex,
  ms,
  rowsSheet,
  sheet,
  upload,
  xlsx,
  zip,
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

const FROM = '2026-10-01T00:00:00+08:00';
const TO = '2026-11-01T00:00:00+08:00';

async function nothingLeft(f: Fixture) {
  expect(await f.state()).toEqual({ imports: [], failures: [], audits: [], sent: 0, puts: 0 });
}

// ---------------------------------------------------------------- 受理：新任务、文件进导入存储

it('[AC-B1-09g#7] 维权单：answer queued；rights_imports 一行（queued、建单人、受理时刻），文件存进导入存储', async () => {
  const f = await fixture(h);
  const bytes = sheet(['succeeded', 'skipped', 'failed:order_not_found']);
  const result = await f.create({ kind: 'rights', platform: 'pdd', file: upload(bytes) });
  expect(result).toMatchObject({ code: 0, data: { status: 'queued' } });
  await conforms(result.data, 'AdminRightsImportCreated');
  const importId = (result.data as { import_id: string }).import_id;
  const row = await f.task(importId);
  expect(row).toMatchObject({
    id: importId,
    app_id: f.appId,
    kind: 'rights',
    platform: 'pdd',
    union_account_id: null,
    time_basis: null,
    from: null,
    to: null,
    status: 'queued',
    created_by: f.adminId,
    finished_at: null,
  });
  expect(ms(row?.created_at)).toBe(f.clock.now().getTime());
  expect(row?.file_path).toEqual(expect.any(String));
  expect(row?.file_path).not.toContain(FILENAME);
  expect(hex(await f.memory.get(row!.file_path))).toBe(hex(bytes));
  expect(f.puts.map((p) => p.key)).toEqual([row!.file_path]);
});

it('[AC-B1-09g#7] 带完整时间窗：time_basis / from / to 原样入库', async () => {
  const f = await fixture(h);
  const { importId } = await f.accepted({
    kind: 'punish',
    platform: 'taobao',
    time_basis: 'received',
    from: FROM,
    to: TO,
  });
  const row = await f.task(importId);
  expect(row).toMatchObject({ kind: 'punish', platform: 'taobao', time_basis: 'received' });
  expect(ms(row?.from)).toBe(new Date(FROM).getTime());
  expect(ms(row?.to)).toBe(new Date(TO).getTime());
});

it('[AC-B1-09g#7] 只带 time_basis：受理并忽略，不存时间窗', async () => {
  const f = await fixture(h);
  const { importId } = await f.accepted({ time_basis: 'paid' });
  expect(await f.task(importId)).toMatchObject({ time_basis: null, from: null, to: null });
});

it('[AC-B1-09g#7] 渠道单：带本 App 的联盟账号受理，无时间窗', async () => {
  const f = await fixture(h);
  const { importId } = await f.accepted({
    kind: 'channel',
    platform: 'taobao',
    union_account_id: f.accountId,
  });
  expect(await f.task(importId)).toMatchObject({
    kind: 'channel',
    platform: 'taobao',
    union_account_id: f.accountId,
    time_basis: null,
    from: null,
    to: null,
    status: 'queued',
  });
});

it('[AC-B1-09g#7] 同一文件上传两次：两个任务、两份文件、两个任务入队，互不去重', async () => {
  const f = await fixture(h);
  const bytes = sheet(['succeeded', 'duplicate']);
  const first = await f.accepted({ file: upload(bytes) });
  const second = await f.accepted({ file: upload(bytes) });
  expect(second.importId).not.toBe(first.importId);
  const rows = [await f.task(first.importId), await f.task(second.importId)];
  expect(rows.map((r) => r?.status)).toEqual(['queued', 'queued']);
  expect(new Set(rows.map((r) => r?.file_path)).size).toBe(2);
  for (const row of rows) expect(hex(await f.memory.get(row!.file_path))).toBe(hex(bytes));
  expect(f.queue.sent).toHaveLength(2);
  expect(first.send.options.singletonKey).not.toBe(second.send.options.singletonKey);
  expect((await f.state()).audits).toHaveLength(2);
});

it(`[AC-B1-09g#7] 表头下 ${MAX_ROWS - 1} 行：受理`, async () => {
  const f = await fixture(h);
  const { importId } = await f.accepted({ file: upload(rowsSheet(MAX_ROWS - 1)) });
  expect(await f.task(importId)).toMatchObject({ status: 'queued' });
});

// ---------------------------------------------------------------- 整份一条审计

it('[AC-B1-09g#8] 审计：操作人、kind、platform、文件名、行数；目标为该任务；不带单元格内容', async () => {
  const f = await fixture(h);
  const { importId } = await f.accepted({
    kind: 'punish',
    platform: 'jd',
    file: upload(sheet(['succeeded', 'skipped', 'duplicate'])),
  });
  const { audits } = await f.state();
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    app_id: f.appId,
    admin_id: f.adminId,
    action: AUDIT_ACTION,
    target: `rights_imports:${importId}`,
    ip: IP,
  });
  expect(ms(audits[0]?.at)).toBe(f.clock.now().getTime());
  expect(audits[0]?.after).toMatchObject({
    kind: 'punish',
    platform: 'jd',
    filename: FILENAME,
    total_rows: 3,
  });
  // audit_logs.id 是 bigint：序列化时转字符串，只为检查单元格内容不进审计。
  expect(
    JSON.stringify(audits, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  ).not.toContain(PRIVATE_CELL);
});

// ---------------------------------------------------------------- 入队：order-sync 队列的 rights_import 任务

it('[AC-B1-09g#9] 任务名、载荷、同一事务、exclusive 队列的 singletonKey（经平台 validateSend）', async () => {
  const f = await fixture(h);
  const { importId, send } = await f.accepted({ file: upload(sheet(['succeeded'])) });
  expect(send).toMatchObject({ queue: QUEUE, name: JOB, rowVisible: true });
  expect(send.payload).toMatchObject({ app_id: f.appId, import_id: importId });
  expect(send.options.trx?.isTransaction).toBe(true);
  expect(send.options.singletonKey).toEqual(expect.stringContaining(importId));
  const wire = JSON.stringify(send.payload);
  expect(wire).not.toContain(FILENAME);
  expect(wire).not.toContain(PRIVATE_CELL);
  expect(f.lines.join('\n')).not.toContain(PRIVATE_CELL);
});

// ---------------------------------------------------------------- 不受理：20001，什么都不留下

it.each([
  ['不是 xlsx（PNG）', () => upload(PNG)],
  ['不是 xlsx（文本）', () => upload(Buffer.from(`${PRIVATE_CELL},a,b\n`))],
  ['zip 但不是电子表格', () => upload(zip([{ name: 'readme.txt', data: Buffer.from('x') }]))],
  ['xlsx 截断', () => upload(sheet(['succeeded']).subarray(0, 120))],
  [`表头下 ${MAX_ROWS + 1} 行`, () => upload(rowsSheet(MAX_ROWS + 1))],
])('[AC-B1-09g#10] %s → 20001 [file]，什么都不留下', async (_label, file) => {
  const f = await fixture(h);
  expect(await f.create({ file: file() })).toEqual(fieldsError('file'));
  await nothingLeft(f);
});

it('[AC-B1-09g#10] 没有文件 → 20001 [file]，什么都不留下', async () => {
  const f = await fixture(h);
  expect(await f.create({ file: undefined })).toEqual(fieldsError('file'));
  await nothingLeft(f);
});

it.each([
  [{ kind: 'refund' }, 'kind'],
  [{ kind: undefined }, 'kind'],
  [{ platform: 'alibaba' }, 'platform'],
  [{ from: FROM, to: TO }, 'time_basis'],
  [{ time_basis: 'paid', from: FROM }, 'to'],
  [{ kind: 'channel', union_account_id: undefined }, 'union_account_id'],
])('[AC-B1-09g#10] 表单 %j → 20001 [%s]，什么都不留下', async (patch, field) => {
  const f = await fixture(h);
  expect(await f.create(patch)).toEqual(fieldsError(field));
  await nothingLeft(f);
});

it('[AC-B1-09g#10] 渠道单带 time_basis → 20001 [time_basis]', async () => {
  const f = await fixture(h);
  const result = await f.create({
    kind: 'channel',
    union_account_id: f.accountId,
    time_basis: 'paid',
  });
  expect(result).toEqual(fieldsError('time_basis'));
  await nothingLeft(f);
});

it('[AC-B1-09g#10] 渠道单的联盟账号不存在或属于别的 App → 20001 [union_account_id]', async () => {
  const f = await fixture(h);
  const other = await f.account('taobao', newAppId());
  for (const accountId of [randomUUID(), other]) {
    const result = await f.create({ kind: 'channel', union_account_id: accountId });
    expect(result).toEqual(fieldsError('union_account_id'));
  }
  await nothingLeft(f);
});

it('[AC-B1-09g#10] 不合的请求不打文件内容', async () => {
  const f = await fixture(h);
  await f.create({ file: upload(xlsx([[PRIVATE_CELL]]).subarray(0, 64)) });
  await f.create({ kind: 'refund', file: upload(sheet(['succeeded'])) });
  expect(f.lines.join('\n')).not.toContain(PRIVATE_CELL);
  await nothingLeft(f);
});
