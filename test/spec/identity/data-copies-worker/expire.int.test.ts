// B1-27h（08 BR-ID-30 ⑨「24 小时后过期」、BR-ID-40 细则「交付（默认）」「重新登记与登记人停用」；brief §9 ⑤）：
// data-copy 队列的 expire 作业。到 expires_at（注入的 Clock）时 ready / delivered → expired 并删除文件、清空
// object_key；企业微信路径没交付就过期的照样记 expired（不改成 failed）；提前到达的作业不改行、按剩余时间
// 再入队一次；已取消或已失败但还留着文件的请求，到期时只删文件、清空 object_key，状态不变；没有文件的
// 未结束请求不受影响。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DAY_MS,
  EXPIRE,
  GENERATE,
  HOUR_MS,
  QUEUE,
  SECOND_MS,
  at,
  close,
  fixture,
  open,
  type Base,
  type CopyRow,
} from './kit.ts';

const TIMEOUT = 120_000;
let database: TestDatabase | undefined;
let base: Base | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  base = await open(database);
}, TIMEOUT);

afterAll(async () => {
  try {
    await close(base);
  } finally {
    await database?.drop();
  }
});

function harness(): Base {
  if (base === undefined) throw new Error('the test database is not open');
  return base;
}

it('[AC-B1-27h#22] in_app_sms 已交付：23 小时时的 expire 作业不改行、按剩余时间再入队；过了 expires_at → expired，文件删除、object_key 清空', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const u = await f.user();
  const row = await f.copy({ userId: u.uid, delivery: 'in_app_sms' });
  await worker.handle(f.job(GENERATE, row.id));
  const delivered = await f.row(row.id);
  expect(delivered.status).toBe('delivered');
  const key = delivered.object_key!;

  f.clock.advanceMs(23 * HOUR_MS);
  const before = f.sends().length;
  await worker.handle(f.job(EXPIRE, row.id));
  expect(await f.row(row.id)).toEqual(delivered);
  expect(f.store.get(key)).toBeDefined();
  const again = f.sends().slice(before);
  expect(again).toHaveLength(1);
  expect(again[0]).toMatchObject({
    queue: QUEUE,
    name: EXPIRE,
    payload: { appId: f.appId, copyId: row.id },
  });
  expect(again[0]!.delaySeconds).toBeGreaterThan(0);
  expect(again[0]!.delaySeconds).toBeLessThanOrEqual(HOUR_MS / SECOND_MS);

  f.clock.advanceMs(HOUR_MS + SECOND_MS);
  await worker.handle(f.job(EXPIRE, row.id));
  const expired = await f.row(row.id);
  expect(expired).toMatchObject({
    status: 'expired',
    object_key: null,
    delivered_at: delivered.delivered_at,
    expires_at: delivered.expires_at,
    generated_at: delivered.generated_at,
  });
  expect(expired.row_version).toBeGreaterThan(delivered.row_version);
  expect(f.store.get(key)).toBeUndefined();
  expect(f.liveKeys()).toEqual([]);
  // A late duplicate changes nothing more.
  await worker.handle(f.job(EXPIRE, row.id));
  expect(await f.row(row.id)).toEqual(expired);
});

it('[AC-B1-27h#23] wecom_session 生成后一直没交付（ready）：过了 expires_at → expired（不是 failed），文件删除、object_key 清空', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const u = await f.user();
  const row = await f.copy({ userId: u.uid, delivery: 'wecom_session' });
  await worker.handle(f.job(GENERATE, row.id));
  const ready = await f.row(row.id);
  expect(ready.status).toBe('ready');
  f.clock.advanceMs(DAY_MS + SECOND_MS);
  await worker.handle(f.job(EXPIRE, row.id));
  const expired = await f.row(row.id);
  expect(expired).toMatchObject({
    status: 'expired',
    object_key: null,
    delivered_at: null,
    failure_reason: null,
  });
  expect(f.store.get(ready.object_key!)).toBeUndefined();
  expect(f.liveKeys()).toEqual([]);
});

it('[AC-B1-27h#24] 已取消 / 已失败但还留着文件的请求：到期的 expire 作业只删文件、清空 object_key，状态不变；没有文件的 pending 不受影响', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const rows: { readonly row: CopyRow; readonly key: string }[] = [];
  for (const status of ['cancelled', 'failed'] as const) {
    const u = await f.user();
    const row = await f.copy({
      userId: u.uid,
      delivery: 'in_app_sms',
      status,
      generatedAt: at(-DAY_MS - HOUR_MS),
      expiresAt: at(-HOUR_MS),
      failureReason: status === 'failed' ? '演示失败' : null,
    });
    const key = await f.storedObject(row.id);
    await f.db
      .withSchema('app')
      .updateTable('personal_data_copies')
      .set({ object_key: key })
      .where('id', '=', row.id)
      .execute();
    rows.push({ row: await f.row(row.id), key });
  }
  const pendingUser = await f.user();
  const pending = await f.copy({ userId: pendingUser.uid, delivery: 'in_app_sms' });

  for (const { row, key } of rows) {
    await worker.handle(f.job(EXPIRE, row.id));
    const after = await f.row(row.id);
    expect(after.status, row.status).toBe(row.status);
    expect(after.object_key, row.status).toBeNull();
    expect(after.failure_reason).toBe(row.failure_reason);
    expect(f.store.get(key), row.status).toBeUndefined();
  }
  await worker.handle(f.job(EXPIRE, pending.id));
  expect(await f.row(pending.id)).toEqual(pending);
  expect(f.liveKeys()).toEqual([]);
});
