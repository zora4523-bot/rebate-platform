import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  MIN,
  NOW_MS,
  PDD_CAP,
  cursor,
  iso,
  manualKey,
  ok,
  setup,
  text,
  unionAccount,
  windows,
  type Created,
} from './kit.ts';

const h = useHarness();
const FROM_MS = NOW_MS - 180 * MIN;

it.each([10, 30, 60, 70, 95])(
  '[AC-B1-09i#11] 拼多多 %i 分钟的时间窗按 30 分钟上限切成连续窗口，逐窗投递 order-sync',
  async (minutes) => {
    const s = await setup(h);
    const acc = await unionAccount(s, 'pdd');
    const to = FROM_MS + minutes * MIN;
    const created = await ok<Created>(
      await s.post({ platform: 'pdd', from: iso(FROM_MS), to: iso(to) }),
      'create',
    );
    const jobs = windows(s.jobs());
    expect(jobs).toHaveLength(Math.ceil((minutes * MIN) / PDD_CAP));
    expect(jobs[0]!.start).toBe(FROM_MS);
    expect(jobs.at(-1)!.end).toBe(to);
    jobs.forEach((job, i) => {
      expect(job.end - job.start).toBeGreaterThan(0);
      expect(job.end - job.start).toBeLessThanOrEqual(PDD_CAP);
      if (i > 0) expect(job.start).toBe(jobs[i - 1]!.end);
      expect(job.sent.payload).toMatchObject({
        app_id: s.appId,
        platform: 'pdd',
        union_account_id: acc.id,
        scene: '-',
        sync_id: created.sync_id,
      });
      expect(text(job.sent.payload, 'query_kind')).not.toBe('');
    });
  },
);

it('[AC-B1-09i#12] 窗口任务的去重键为 platform:account:kind:scene:manual:<filter_digest>:window_start', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  const created = await ok<Created>(
    await s.post({ platform: 'pdd', from: iso(FROM_MS), to: iso(FROM_MS + 70 * MIN) }),
    'create',
  );
  const [row] = await s.rows();
  expect(row).toMatchObject({ id: created.sync_id });
  expect(row!.filter_digest).toMatch(/^[0-9a-f]{64}$/);
  const keys = s.jobs().map((job) => job.options.singletonKey);
  expect(keys).toEqual(s.jobs().map((job) => manualKey(job.payload, row!.filter_digest)));
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9:._+-]{1,200}$/);
});

it('[AC-B1-09i#13] 手动同步不读也不推水位：窗口从 from 起算而不是从游标，sync_cursors 原样', async () => {
  const s = await setup(h);
  const acc = await unionAccount(s, 'pdd');
  const cursorAt = iso(FROM_MS + 45 * MIN);
  await cursor(s, acc, cursorAt);
  const before = await s.cursors();
  await ok<Created>(
    await s.post({ platform: 'pdd', from: iso(FROM_MS), to: iso(FROM_MS + 90 * MIN) }),
    'create',
  );
  const jobs = windows(s.jobs());
  expect(jobs.map((job) => [job.start, job.end])).toEqual([
    [FROM_MS, FROM_MS + 30 * MIN],
    [FROM_MS + 30 * MIN, FROM_MS + 60 * MIN],
    [FROM_MS + 60 * MIN, FROM_MS + 90 * MIN],
  ]);
  expect(await s.cursors()).toEqual(before);
  expect(before).toHaveLength(1);
});

it('[AC-B1-09i#14] 新请求按令牌身份落库：queued、计数为 0、created_at 取注入时钟，响应与行一致', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  const from = '2026-10-09T07:00:00+08:00';
  const to = '2026-10-09T07:40:00+08:00';
  const created = await ok<Created>(await s.post({ platform: 'pdd', from, to }), 'create');
  expect(created).toMatchObject({ status: 'queued', reused: false });
  expect(Date.parse(created.created_at)).toBe(s.f.clock.now().getTime());
  const rows = await s.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: created.sync_id,
    app_id: s.appId,
    platform: 'pdd',
    mode: 'window',
    from: new Date(from),
    to: new Date(to),
    status_filter: null,
    order_nos: null,
    status: 'queued',
    requested_by: s.a.id,
    fetched_count: 0,
    stored_count: 0,
    error: null,
    finished_at: null,
    created_at: s.f.clock.now(),
  });
});
