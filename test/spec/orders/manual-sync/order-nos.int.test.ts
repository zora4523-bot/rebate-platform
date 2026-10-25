import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { MIN, NOW_MS, cursor, fields, iso, ok, setup, unionAccount, type Created } from './kit.ts';

const h = useHarness();
const NUMBERS = ['231006-1234567891', '231006-1234567892'];

it('[AC-B1-09i#20] 拼多多按单号：建 order_nos 请求并向 order-sync 投递单号任务，键带 manual 与筛选摘要，水位不动', async () => {
  const s = await setup(h);
  const acc = await unionAccount(s, 'pdd');
  await cursor(s, acc, iso(NOW_MS - 30 * MIN));
  const before = await s.cursors();
  const created = await ok<Created>(
    await s.post({ platform: 'pdd', order_nos: NUMBERS }),
    'create',
  );
  expect(created).toMatchObject({ status: 'queued', reused: false });
  const rows = await s.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: created.sync_id,
    platform: 'pdd',
    mode: 'order_nos',
    order_nos: NUMBERS,
    from: null,
    to: null,
    status_filter: null,
    status: 'queued',
    requested_by: s.a.id,
  });
  const jobs = s.jobs();
  expect(jobs.length).toBeGreaterThan(0);
  for (const job of jobs) {
    expect(job.payload).toMatchObject({
      app_id: s.appId,
      platform: 'pdd',
      union_account_id: acc.id,
      sync_id: created.sync_id,
    });
    expect(job.options.singletonKey).toContain(`:manual:${rows[0]!.filter_digest}`);
  }
  const carried = JSON.stringify(jobs.map((job) => job.payload));
  for (const no of NUMBERS) expect(carried).toContain(no);
  expect(await s.cursors()).toEqual(before);
  // 02 §19 / orders AGENTS.md 10: no full order number in a log line.
  for (const no of NUMBERS) expect(s.f.lines.join('\n')).not.toContain(no);
});

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09i#21] %s 按单号暂不支持（CAP-*-07 未实测）→ 20001 fields=[order_nos]，不建请求不投递',
  async (platform) => {
    const s = await setup(h);
    await unionAccount(s, platform);
    await fields(await s.post({ platform, order_nos: NUMBERS }), 'create', ['order_nos']);
    expect(await s.rows()).toEqual([]);
    expect(s.jobs()).toEqual([]);
    // The same platform by time window is not refused for that reason.
    const response = await s.post({
      platform,
      from: iso(NOW_MS - 120 * MIN),
      to: iso(NOW_MS - 110 * MIN),
    });
    expect(response.json<{ data?: { fields?: string[] } }>().data?.fields ?? []).not.toContain(
      'order_nos',
    );
  },
);
