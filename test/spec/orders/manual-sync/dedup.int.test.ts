import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { MIN, NOW_MS, iso, ok, setup, unionAccount, type Created, type Scenario } from './kit.ts';

const h = useHarness();
const FROM = '2026-10-09T07:00:00+08:00';
const TO = '2026-10-09T08:00:00+08:00';
const WINDOW = { platform: 'pdd', from: FROM, to: TO };

async function create(s: Scenario, body: object = WINDOW) {
  return ok<Created>(await s.post(body), 'create');
}

it('[AC-B1-09i#15] 排队中重复提交同一筛选（含同一时刻的不同偏移写法）返回原请求 reused=true，不再建行不再投递', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  const first = await create(s);
  expect(first).toMatchObject({ status: 'queued', reused: false });
  const dispatched = s.jobs().length;
  expect(dispatched).toBe(2);
  s.f.clock.advanceMs(MIN);
  for (const body of [
    WINDOW,
    { platform: 'pdd', from: '2026-10-08T23:00:00Z', to: '2026-10-09T00:00:00.000Z' },
  ]) {
    expect(await create(s, body)).toEqual({ ...first, reused: true });
  }
  expect(await s.rows()).toHaveLength(1);
  expect(s.jobs()).toHaveLength(dispatched);
});

it('[AC-B1-09i#16] 执行中重复提交返回原请求 reused=true，状态为 running', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  const first = await create(s);
  await h.db
    .updateTable('order_sync_requests')
    .set({ status: 'running' })
    .where('id', '=', first.sync_id)
    .execute();
  const dispatched = s.jobs().length;
  expect(await create(s)).toEqual({ ...first, status: 'running', reused: true });
  expect(await s.rows()).toHaveLength(1);
  expect(s.jobs()).toHaveLength(dispatched);
});

it.each(['done', 'failed'] as const)(
  '[AC-B1-09i#17] 原请求 %s 之后再提交同一筛选建新请求并重新投递',
  async (status) => {
    const s = await setup(h);
    await unionAccount(s, 'pdd');
    const first = await create(s);
    await h.db
      .updateTable('order_sync_requests')
      .set({ status, finished_at: s.f.clock.now() })
      .where('id', '=', first.sync_id)
      .execute();
    const dispatched = s.jobs().length;
    s.f.clock.advanceMs(MIN);
    const second = await create(s);
    expect(second).toMatchObject({ status: 'queued', reused: false });
    expect(second.sync_id).not.toBe(first.sync_id);
    const rows = await s.rows();
    expect(rows.map((row) => row.id)).toEqual([first.sync_id, second.sync_id]);
    expect(rows[1]!.filter_digest).toBe(rows[0]!.filter_digest);
    const again = s.jobs().slice(dispatched);
    expect(again).toHaveLength(dispatched);
    expect(again.every((job) => job.payload['sync_id'] === second.sync_id)).toBe(true);
    // The live one is the new request now.
    expect(await create(s)).toEqual({ ...second, reused: true });
  },
);

it('[AC-B1-09i#18] 筛选不同（时间窗、平台、单号）各自建请求；另一应用的同一筛选互不复用', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  const base = await create(s);
  const shifted = await create(s, { ...WINDOW, to: '2026-10-09T07:30:00+08:00' });
  const one = await create(s, { platform: 'pdd', order_nos: ['231006-1234567891'] });
  const two = await create(s, {
    platform: 'pdd',
    order_nos: ['231006-1234567891', '231006-1234567892'],
  });
  const ids = [base, shifted, one, two].map((c) => c.sync_id);
  expect(new Set(ids).size).toBe(4);
  for (const c of [base, shifted, one, two]) expect(c.reused).toBe(false);
  expect(await create(s, { platform: 'pdd', order_nos: ['231006-1234567891'] })).toEqual({
    ...one,
    reused: true,
  });
  const other = await setup(h);
  await unionAccount(other, 'pdd');
  const foreign = await create(other);
  expect(foreign.reused).toBe(false);
  expect(ids).not.toContain(foreign.sync_id);
  expect((await other.rows()).map((row) => row.id)).toEqual([foreign.sync_id]);
  expect(await s.rows()).toHaveLength(4);
});

it('[AC-B1-09i#19] 同一筛选并发提交只建一行：一个 reused=false、另一个返回同一 sync_id 且 reused=true', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  const from = iso(NOW_MS - 120 * MIN);
  const to = iso(NOW_MS - 100 * MIN);
  const results = await Promise.all(
    [0, 1, 2].map(async () => ok<Created>(await s.post({ platform: 'pdd', from, to }), 'create')),
  );
  expect(new Set(results.map((r) => r.sync_id)).size).toBe(1);
  expect(results.map((r) => r.reused).sort()).toEqual([false, true, true]);
  expect(await s.rows()).toHaveLength(1);
  expect(s.jobs()).toHaveLength(1);
});
