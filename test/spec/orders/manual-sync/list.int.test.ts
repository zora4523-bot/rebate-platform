import { expect, it } from 'vitest';
import { account, useHarness } from '../../admin/auth/kit.ts';
import {
  DAY,
  MIN,
  NOW_MS,
  fields,
  iso,
  ok,
  seedRequest,
  setup,
  unionAccount,
  type Created,
  type Page,
} from './kit.ts';

const h = useHarness();
const ids = (page: Page) => page.items.map((item) => item.sync_id);
const instant = (value: string | null) => (value === null ? null : Date.parse(value));

it('[AC-B1-09i#27] 列表按 created_at 倒序给本应用的请求，字段与库一致，申请人显示名回退登录名', async () => {
  const s = await setup(h, { displayName: '客服小林' });
  const plain = await account(h, { app_id: s.appId });
  const older = await seedRequest(s, {
    created_at: iso(NOW_MS - 3 * DAY),
    finished_at: iso(NOW_MS - 3 * DAY + 9_000),
    fetched_count: 120,
    stored_count: 118,
  });
  const byNumber = await seedRequest(s, {
    mode: 'order_nos',
    from: null,
    to: null,
    order_nos: ['231006-1234567891'],
    status: 'failed',
    error: 'synthetic failure',
    requested_by: plain.id,
    created_at: iso(NOW_MS - 2 * DAY),
    finished_at: iso(NOW_MS - 2 * DAY + MIN),
  });
  const running = await seedRequest(s, {
    status: 'running',
    status_filter: 'synthetic-filter',
    fetched_count: 7,
    stored_count: 3,
    created_at: iso(NOW_MS - DAY),
    finished_at: null,
  });
  const other = await setup(h);
  await seedRequest(other, { created_at: iso(NOW_MS - 12 * 60 * MIN) });

  const page = await ok<Page>(await s.list(), 'list');
  expect(ids(page)).toEqual([running.id, byNumber.id, older.id]);
  expect(page).toMatchObject({ page: 1, total: 3 });
  const [first, second, third] = page.items;
  expect(first).toMatchObject({
    sync_id: running.id,
    platform: 'pdd',
    mode: 'window',
    status_filter: 'synthetic-filter',
    order_nos: null,
    status: 'running',
    requested_by: s.a.id,
    requested_by_name: '客服小林',
    fetched_count: 7,
    stored_count: 3,
    finished_at: null,
  });
  expect(instant(first!.from)).toBe(running.from!.getTime());
  expect(instant(first!.to)).toBe(running.to!.getTime());
  expect(instant(first!.created_at)).toBe(running.created_at.getTime());
  expect(second).toMatchObject({
    sync_id: byNumber.id,
    mode: 'order_nos',
    from: null,
    to: null,
    status_filter: null,
    order_nos: ['231006-1234567891'],
    status: 'failed',
    requested_by: plain.id,
    requested_by_name: plain.username,
  });
  expect(instant(second!.finished_at)).toBe(byNumber.finished_at!.getTime());
  expect(third).toMatchObject({ sync_id: older.id, status: 'done', fetched_count: 120 });
  expect(JSON.stringify(page)).not.toContain('synthetic failure');
  expect(JSON.stringify(page)).not.toContain('filter_digest');
});

it('[AC-B1-09i#28] 分页：page_size 与 page 切片，越过末页 items=[]，total 计全部；page_size>200 → 20001', async () => {
  const s = await setup(h);
  const rows: Awaited<ReturnType<typeof seedRequest>>[] = [];
  for (let i = 0; i < 5; i += 1) {
    rows.push(await seedRequest(s, { created_at: iso(NOW_MS - DAY + i * MIN) }));
  }
  const newest = rows.map((row) => row.id).reverse();
  const p1 = await ok<Page>(await s.list({ page: '1', page_size: '2' }), 'list');
  const p2 = await ok<Page>(await s.list({ page: '2', page_size: '2' }), 'list');
  const p3 = await ok<Page>(await s.list({ page: '3', page_size: '2' }), 'list');
  const p4 = await ok<Page>(await s.list({ page: '4', page_size: '2' }), 'list');
  expect([ids(p1), ids(p2), ids(p3), ids(p4)]).toEqual([
    newest.slice(0, 2),
    newest.slice(2, 4),
    newest.slice(4),
    [],
  ]);
  for (const page of [p1, p2, p3, p4]) expect(page).toMatchObject({ page_size: 2, total: 5 });
  expect(await ok<Page>(await s.list({ page_size: '200' }), 'list')).toMatchObject({
    page_size: 200,
    total: 5,
  });
  await fields(await s.list({ page_size: '201' }), 'list', ['page_size']);
});

it('[AC-B1-09i#29] 刚提交的请求出现在列表首位；读接口不写审计、不改请求', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  await seedRequest(s, { created_at: iso(NOW_MS - DAY) });
  s.f.clock.advanceMs(MIN);
  const created = await ok<Created>(
    await s.post({ platform: 'pdd', from: iso(NOW_MS - 90 * MIN), to: iso(NOW_MS - 60 * MIN) }),
    'create',
  );
  const before = { rows: await s.rows(), audits: await s.audits() };
  const page = await ok<Page>(await s.list(), 'list');
  expect(page.total).toBe(2);
  expect(page.items[0]).toMatchObject({
    sync_id: created.sync_id,
    mode: 'window',
    status: 'queued',
    order_nos: null,
    status_filter: null,
    fetched_count: 0,
    stored_count: 0,
    finished_at: null,
    requested_by: s.a.id,
  });
  expect(instant(page.items[0]!.created_at)).toBe(Date.parse(created.created_at));
  await ok(await s.limits(), 'limits');
  expect({ rows: await s.rows(), audits: await s.audits() }).toEqual(before);
});
