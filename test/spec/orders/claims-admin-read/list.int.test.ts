import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { ZERO, claim, ids, item, log, page, rejected, seed, setup } from './kit.ts';

const h = useHarness();

it('[AC-B1-10j#10] auto_matched 先置顶，两组各按提交时间倒序，分页不改变计数', async () => {
  const s = await setup(h);
  const autoOld = await seed(s, {
    status: 'auto_matched',
    evidence_level: 'strong',
    created_at: '2026-10-07T01:00:00Z',
  });
  const manualNew = await seed(s, { created_at: '2026-10-08T00:00:00Z' });
  const autoNew = await seed(s, {
    status: 'auto_matched',
    evidence_level: 'strong',
    created_at: '2026-10-07T02:00:00Z',
  });
  const approved = await seed(s, { status: 'approved', created_at: '2026-10-07T06:00:00Z' });
  const cancelled = await seed(s, { status: 'cancelled', created_at: '2026-10-07T05:00:00Z' });
  const rejectedClaim = await seed(s, { status: 'rejected', created_at: '2026-10-07T04:00:00Z' });
  const counts = {
    ...ZERO,
    auto_matched: 2,
    manual_review: 1,
    approved: 1,
    rejected: 1,
    cancelled: 1,
  };
  const all = await page(await s.get());
  expect(ids(all)).toEqual([
    autoNew.id,
    autoOld.id,
    manualNew.id,
    approved.id,
    cancelled.id,
    rejectedClaim.id,
  ]);
  expect(all).toMatchObject({ page: 1, page_size: 20, total: 6, counts });
  const seen: string[] = [];
  for (let n = 1; n <= 4; n += 1) {
    const p = await page(await s.get({ page: String(n), page_size: '2' }));
    expect(p).toMatchObject({ page: n, page_size: 2, total: 6, counts });
    expect(ids(p)).toEqual(ids(all).slice((n - 1) * 2, n * 2));
    seen.push(...ids(p));
  }
  expect(seen).toEqual(ids(all));
  expect((await page(await s.get({ page_size: '200', page: '100000' }))).items).toEqual([]);
});

it('[AC-B1-10j#11] 筛选按 AND，counts 忽略 status 但保留平台、证据、用户和 q', async () => {
  const s = await setup(h);
  const common = { platform: 'jd', evidence_level: 'weak', order_no: 'FILTER-EXACT' };
  const approved = await seed(s, { ...common, status: 'approved' });
  await seed(s, { ...common, status: 'rejected' });
  await seed(s, { ...common, status: 'approved', platform: 'pdd' });
  await seed(s, { ...common, status: 'approved', evidence_level: 'none' });
  await seed(s, { ...common, status: 'approved', user_id: await seedUser(h.db, s.appId) });
  await seed(s, { ...common, status: 'approved', order_no: 'FILTER-EXACT-SUFFIX' });
  const query = {
    platform: 'jd',
    evidence_level: 'weak',
    user_id: s.userId,
    q: 'FILTER-EXACT',
    status: 'approved',
  };
  const p = await page(await s.get(query));
  expect(ids(p)).toEqual([approved.id]);
  expect(p).toMatchObject({ total: 1, counts: { ...ZERO, approved: 1, rejected: 1 } });
  const empty = await page(await s.get({ ...query, status: 'cancelled' }));
  expect(empty).toMatchObject({ items: [], total: 0, counts: p.counts });
});

it('[AC-B1-10j#12] 不存在的用户、无命中的非状态筛选返回空页和六个零', async () => {
  const s = await setup(h);
  await seed(s);
  const queries: Record<string, string>[] = [
    { user_id: randomUUID() },
    { platform: 'pdd' },
    { q: 'does-not-exist' },
    { evidence_level: 'strong' },
  ];
  for (const query of queries) {
    expect(await page(await s.get(query))).toMatchObject({ items: [], total: 0, counts: ZERO });
  }
});

it('[AC-B1-10j#13] q 精确匹配 claim_id、提交单号、任一子单号，去首尾和内部空格', async () => {
  const s = await setup(h);
  const c = await claim(s, { order_no: 'PARENT-EXACT' });
  const child = await item(s, c, {}, { sub_order_id: 'CHILD-EXACT' });
  await item(s, c);
  await seed(s, { order_no: 'PARENT-EXACT-SUFFIX' });
  for (const q of [c.id, c.order_no, child.sub_order_id, '  PA RENT- EXACT  ']) {
    const p = await page(await s.get({ q }));
    expect(ids(p)).toEqual([c.id]);
    expect(p).toMatchObject({ total: 1, counts: { ...ZERO, manual_review: 1 } });
  }
  for (const q of ['PARENT', 'CHILD', c.id.slice(0, 16), '%', '_', s.userId]) {
    expect(await page(await s.get({ q }))).toMatchObject({ items: [], total: 0, counts: ZERO });
  }
});

it('[AC-B1-10j#14] 一个 claim 多个命中子项只计一次，证据筛选使用 claim 级别', async () => {
  const s = await setup(h);
  const c = await seed(s, { order_no: 'SAME-NUMBER', evidence_level: 'weak' });
  await item(
    s,
    c,
    { evidence: 'strong', evidence_link_log_ids: [(await log(s)).id] },
    { sub_order_id: 'SAME-NUMBER' },
  );
  const p = await page(await s.get({ q: 'SAME-NUMBER', evidence_level: 'weak' }));
  expect(ids(p)).toEqual([c.id]);
  expect(p).toMatchObject({ total: 1, counts: { ...ZERO, manual_review: 1 } });
  expect((await page(await s.get({ evidence_level: 'none' }))).items).toEqual([]);
});

it.each(['', '   ', 'x'.repeat(65)])('[AC-B1-10j#15] q 规范化后非法长度 %j 报 q', async (q) => {
  const s = await setup(h);
  await rejected(await s.get({ q }), 20001, { fields: ['q'] });
});

it.each([1, 64])('[AC-B1-10j#16] q 长度边界 %s 在去空格后检查', async (length) => {
  const s = await setup(h);
  const c = await seed(s, { order_no: 'x'.repeat(length) });
  expect(ids(await page(await s.get({ q: `  ${c.order_no.split('').join(' ')}  ` })))).toEqual([
    c.id,
  ]);
});

it.each([
  ['platform', 'unknown'],
  ['evidence_level', 'unknown'],
  ['status', 'unknown'],
  ['user_id', 'not-a-uuid'],
  ['page', '0'],
  ['page', '-1'],
  ['page', '1.5'],
  ['page_size', '0'],
  ['page_size', '201'],
  ['page_size', '1.5'],
])('[AC-B1-10j#17] 非法参数 %s=%s 返回字段错误', async (key, value) => {
  const s = await setup(h);
  await rejected(await s.get({ [key]: value }), 20001, { fields: [key] });
});

it('[AC-B1-10j#29] 状态页计数包括尚未计算证据的 submitted，空页仍保留它的计数', async () => {
  const s = await setup(h);
  await seed(s, { status: 'submitted', evidence_level: null });
  const p = await page(await s.get({ status: 'approved' }));
  expect(p).toMatchObject({ items: [], total: 0, counts: { ...ZERO, submitted: 1 } });
});
