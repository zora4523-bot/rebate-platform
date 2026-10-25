// B1-09i: the window / order-number jobs a manual request dispatched, taken by the worker's
// order-sync handler: status queued → running → done / failed, fetched_count / stored_count so far,
// error and finished_at (the progress columns 0084 grants), sync_cursors never read or advanced.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  MIN,
  NOW_MS,
  cursor,
  iso,
  ok,
  received,
  setup,
  unionAccount,
  windows,
  type Created,
  type Scenario,
} from './kit.ts';
import { unionOrder, worker } from './worker-kit.ts';

const h = useHarness();
const FROM_MS = NOW_MS - 180 * MIN;

async function row(s: Scenario, id: string) {
  const rows = await s.rows();
  const found = rows.find((r) => r.id === id);
  expect(found).toBeDefined();
  return found!;
}

it('[AC-B1-09i#37] 窗口任务：首窗开始即 running，计数逐窗累加，末窗完成后 done 与 finished_at；水位不读不推', async () => {
  const s = await setup(h);
  const acc = await unionAccount(s, 'pdd');
  await cursor(s, acc, iso(FROM_MS - 60 * MIN));
  const cursors = await s.cursors();
  const created = await ok<Created>(
    await s.post({ platform: 'pdd', from: iso(FROM_MS), to: iso(FROM_MS + 70 * MIN) }),
    'create',
  );
  const jobs = windows(s.jobs());
  expect(jobs).toHaveLength(3);
  const w = await worker(h, acc.id);
  try {
    const seen: string[] = [];
    const page = (count: number) => async () => {
      seen.push((await row(s, created.sync_id)).status);
      return { items: Array.from({ length: count }, () => unionOrder()), nextCursor: null };
    };
    w.listOrders
      .mockImplementationOnce(page(2))
      .mockImplementationOnce(page(1))
      .mockImplementationOnce(page(0));
    w.process
      .mockResolvedValueOnce({ kind: 'inserted' })
      .mockResolvedValueOnce({ kind: 'dropped', reason: 'PID_NOT_OURS' })
      .mockResolvedValueOnce({ kind: 'updated' });

    await w.handle(received(jobs[0]!.sent));
    expect(seen).toEqual(['running']);
    expect(await row(s, created.sync_id)).toMatchObject({
      status: 'running',
      fetched_count: 2,
      stored_count: 1,
      error: null,
      finished_at: null,
    });
    await w.handle(received(jobs[1]!.sent));
    expect(await row(s, created.sync_id)).toMatchObject({
      status: 'running',
      fetched_count: 3,
      stored_count: 2,
      finished_at: null,
    });
    await w.handle(received(jobs[2]!.sent));
    expect(await row(s, created.sync_id)).toMatchObject({
      status: 'done',
      fetched_count: 3,
      stored_count: 2,
      error: null,
      finished_at: w.clock.now(),
    });
    expect(seen).toEqual(['running', 'running', 'running']);
    expect(
      w.listOrders.mock.calls.map(([range]) => [Date.parse(range.from), Date.parse(range.to)]),
    ).toEqual(jobs.map((job) => [job.start, job.end]));
    expect(w.process).toHaveBeenCalledTimes(3);
    expect(w.read).not.toHaveBeenCalled();
    expect(w.advance).not.toHaveBeenCalled();
    expect(await s.cursors()).toEqual(cursors);
  } finally {
    await w.close();
  }
});

it('[AC-B1-09i#38] 窗口拉取出错时任务抛出交队列重试，请求未结束也不计数；重试成功后 done', async () => {
  const s = await setup(h);
  const acc = await unionAccount(s, 'pdd');
  const created = await ok<Created>(
    await s.post({ platform: 'pdd', from: iso(FROM_MS), to: iso(FROM_MS + 20 * MIN) }),
    'create',
  );
  const [job] = windows(s.jobs());
  expect(job).toBeDefined();
  const w = await worker(h, acc.id);
  try {
    w.listOrders.mockRejectedValueOnce(new Error('synthetic upstream outage'));
    await expect(w.handle(received(job!.sent, 1))).rejects.toThrow();
    const retrying = await row(s, created.sync_id);
    expect(['queued', 'running']).toContain(retrying.status);
    expect(retrying).toMatchObject({ fetched_count: 0, stored_count: 0, finished_at: null });
    w.listOrders.mockResolvedValueOnce({ items: [unionOrder()], nextCursor: null });
    w.process.mockResolvedValueOnce({ kind: 'inserted' });
    await w.handle(received(job!.sent, 2));
    expect(await row(s, created.sync_id)).toMatchObject({
      status: 'done',
      fetched_count: 1,
      stored_count: 1,
      finished_at: w.clock.now(),
    });
    expect(w.advance).not.toHaveBeenCalled();
  } finally {
    await w.close();
  }
});

it('[AC-B1-09i#39] 任务取出时站长授权已暂停：不拉取，请求 failed 并写 error 与 finished_at；同一筛选随后可重新提交', async () => {
  const s = await setup(h);
  const acc = await unionAccount(s, 'pdd');
  const body = { platform: 'pdd', from: iso(FROM_MS), to: iso(FROM_MS + 20 * MIN) };
  const created = await ok<Created>(await s.post(body), 'create');
  const [job] = windows(s.jobs());
  expect(job).toBeDefined();
  await h.db
    .updateTable('union_accounts')
    .set({ auth_status: 'expired' })
    .where('id', '=', acc.id)
    .execute();
  const w = await worker(h, acc.id);
  try {
    await w.handle(received(job!.sent));
    expect(w.listOrders).not.toHaveBeenCalled();
    const failed = await row(s, created.sync_id);
    expect(failed).toMatchObject({
      status: 'failed',
      fetched_count: 0,
      stored_count: 0,
      finished_at: w.clock.now(),
    });
    expect(failed.error).toEqual(expect.any(String));
    expect(w.advance).not.toHaveBeenCalled();
  } finally {
    await w.close();
  }
  await h.db
    .updateTable('union_accounts')
    .set({ auth_status: 'active' })
    .where('id', '=', acc.id)
    .execute();
  const again = await ok<Created>(await s.post(body), 'create');
  expect(again).toMatchObject({ reused: false, status: 'queued' });
  expect(again.sync_id).not.toBe(created.sync_id);
});

it('[AC-B1-09i#40] 拼多多单号任务经 getPddOrderDetail 逐单拉取并入流水线，完成后 done 与计数；不调 listOrders、不动水位', async () => {
  const s = await setup(h);
  const acc = await unionAccount(s, 'pdd');
  const numbers = ['231006-1234567891', '231006-1234567892'];
  const created = await ok<Created>(
    await s.post({ platform: 'pdd', order_nos: numbers }),
    'create',
  );
  const jobs = s.jobs();
  expect(jobs.length).toBeGreaterThan(0);
  const w = await worker(h, acc.id);
  try {
    w.getPddOrderDetail.mockImplementation(async (orderSn) =>
      unionOrder({ order_id: orderSn, sub_order_id: orderSn }),
    );
    w.process.mockResolvedValueOnce({ kind: 'inserted' }).mockResolvedValueOnce({
      kind: 'unchanged',
    });
    for (const job of jobs) await w.handle(received(job));
    expect(w.getPddOrderDetail.mock.calls.map(([orderSn]) => orderSn).sort()).toEqual(numbers);
    expect(w.process.mock.calls.map(([incoming]) => incoming.sub_order_id).sort()).toEqual(numbers);
    expect(w.listOrders).not.toHaveBeenCalled();
    expect(await row(s, created.sync_id)).toMatchObject({
      status: 'done',
      fetched_count: 2,
      stored_count: 1,
      error: null,
      finished_at: w.clock.now(),
    });
    expect(w.read).not.toHaveBeenCalled();
    expect(w.advance).not.toHaveBeenCalled();
  } finally {
    await w.close();
  }
});
