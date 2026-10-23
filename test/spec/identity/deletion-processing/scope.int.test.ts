// B1-15g: what one round reads (brief §9.2 #2; §9.3 item 11): only status = 'processing', across
// apps, keyset batches until none is left; requests in cooling (even due), done or cancelled and
// their users are never touched; a stop request is honoured between requests.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  close,
  member,
  open,
  processing,
  request,
  reset,
  seedRequest,
  userRow,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});
beforeEach(async () => {
  await reset(kit);
});

it('[AC-B1-15g#27] cooling（已到期）、done、cancelled 的单与其用户不动，端口不调', async () => {
  const cooling = await member(kit.db, { status: 'normal' });
  const done = await member(kit.db, { status: 'deleted' });
  const cancelled = await member(kit.db, { status: 'normal' });
  const rows = [
    await seedRequest(kit.db, cooling, { status: 'cooling' }),
    await seedRequest(kit.db, done, { status: 'done' }),
    await seedRequest(kit.db, cancelled, { status: 'cancelled' }),
  ];
  const users = [cooling, done, cancelled];
  const usersBefore = await Promise.all(users.map((u) => userRow(kit.db, u)));
  const target = await processing(kit.db);
  await kit.runner().runOnce();
  for (const [index, row] of rows.entries()) {
    expect(await request(kit.db, row.id)).toEqual(row);
    expect(await userRow(kit.db, users[index]!)).toEqual(usersBefore[index]);
  }
  expect(kit.calls.every((call) => call.input['userId'] === target.m.uid)).toBe(true);
  expect((await request(kit.db, target.row.id)).status).toBe('done');
});

it('[AC-B1-15g#28] 跨 app：一轮处理所有 app 的 processing 单', async () => {
  const one = await processing(kit.db);
  const two = await processing(kit.db);
  expect(one.m.appId).not.toBe(two.m.appId);
  expect(await kit.runner().runOnce()).toEqual({ scanned: 2 });
  for (const r of [one.row, two.row]) {
    expect((await request(kit.db, r.id)).status).toBe('done');
  }
});

it('[AC-B1-15g#29] 超过一批（batchSize=2、5 单，其中 1 单调账未完成留在 processing）一轮全部读完，scanned=5', async () => {
  const all: Awaited<ReturnType<typeof processing>>[] = [];
  for (let index = 0; index < 5; index += 1) all.push(await processing(kit.db));
  kit.setAdjustment(all[0]!.m, 'pending');
  expect(await kit.runner({ batchSize: 2 }).runOnce()).toEqual({ scanned: 5 });
  expect((await request(kit.db, all[0]!.row.id)).status).toBe('processing');
  for (const item of all.slice(1)) {
    expect((await request(kit.db, item.row.id)).status).toBe('done');
  }
});

it('[AC-B1-15g#30] 停止请求：一开始就停 → 一单不动（scanned=0）；处理完一单后停 → 只完成这一单', async () => {
  const all = [await processing(kit.db), await processing(kit.db), await processing(kit.db)];
  const before = await Promise.all(all.map((item) => request(kit.db, item.row.id)));
  const runner = kit.runner();
  expect(await runner.runOnce(() => true)).toEqual({ scanned: 0 });
  for (const [index, item] of all.entries()) {
    expect(await request(kit.db, item.row.id)).toEqual(before[index]);
  }
  expect(kit.calls).toEqual([]);
  // The stop is requested while the first request is in its completion step.
  const stopping = () => kit.calls.some((call) => call.port === 'funds');
  expect(await runner.runOnce(stopping)).toEqual({ scanned: 1 });
  const statuses = await Promise.all(
    all.map(async (item) => (await request(kit.db, item.row.id)).status),
  );
  expect(statuses.filter((status) => status === 'done')).toHaveLength(1);
  expect(statuses.filter((status) => status === 'processing')).toHaveLength(2);
  const untouched = all.filter((_item, index) => statuses[index] === 'processing');
  for (const item of untouched) {
    expect((await request(kit.db, item.row.id)).cleaned_at).toBeNull();
  }
});
