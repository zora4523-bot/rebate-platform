import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { UNATTRIBUTED, ids, order, page, rejected, setup, token } from './kit.ts';

const h = useHarness();
const EMPTY = { items: [], total: 0 };

it('[AC-B1-10i#20] 按 paid_at 倒序、无 paid_at 的排最后；页码分页不重不漏，越过末页为空页', async () => {
  const s = await setup(h);
  const unpaid = await order(s, { paid_at: null, platform_status: 'DEPOSIT_PAID' });
  const oldest = await order(s, { paid_at: '2026-10-01T01:00:00.000Z' });
  const tieA = await order(s, { paid_at: '2026-10-07T01:00:00.000Z' });
  const newest = await order(s, { paid_at: '2026-10-08T01:00:00.000Z' });
  const tieB = await order(s, { paid_at: '2026-10-07T01:00:00.000Z' });
  const all = await page(await s.get());
  expect(all).toMatchObject({ page: 1, page_size: 20, total: 5 });
  expect(ids(all)[0]).toBe(newest.order_id);
  expect(ids(all).slice(1, 3).sort()).toEqual([tieA.order_id, tieB.order_id].sort());
  expect(ids(all).slice(3)).toEqual([oldest.order_id, unpaid.order_id]);
  const seen: string[] = [];
  for (let n = 1; n <= 3; n += 1) {
    const p = await page(await s.get({ page: String(n), page_size: '2' }));
    expect(p).toMatchObject({ page: n, page_size: 2, total: 5 });
    expect(ids(p)).toEqual(ids(all).slice((n - 1) * 2, n * 2));
    seen.push(...ids(p));
  }
  expect(seen).toEqual(ids(all));
  expect(await page(await s.get({ page: '4', page_size: '2' }))).toMatchObject({
    items: [],
    page: 4,
    page_size: 2,
    total: 5,
  });
  expect((await page(await s.get({ page: '100000', page_size: '200' }))).items).toEqual([]);
});

it('[AC-B1-10i#21] 列表行照 orders 列输出，金额为整数分；未归因订单 user 为 null', async () => {
  const s = await setup(h);
  const held = await order(s, {
    platform: 'pdd',
    title: '抽纸 3 层 120 抽 24 包',
    image_url: 'https://img.example.com/p/a1.jpg',
    paid_at: '2026-10-06T02:58:40.000Z',
    pay_amount_fen: 3990n,
    est_commission_fen: 500n,
    settle_commission_fen: null,
    platform_status: 'PAID',
    rebate_status: 'ESTIMATED',
    hold: true,
    hold_reason: 'CS',
    locked: true,
  });
  const loose = await order(s, {
    ...UNATTRIBUTED,
    parent_order_id: null,
    paid_at: '2026-10-05T13:12:03.000Z',
    pay_amount_fen: 12900n,
    est_commission_fen: 1032n,
    settle_commission_fen: 990n,
    platform_status: 'SETTLED',
    rights_pending: true,
  });
  const p = await page(await s.get());
  expect(p.items).toEqual([
    {
      order_id: held.order_id,
      sub_order_id: held.sub_order_id,
      parent_order_id: held.parent_order_id,
      platform: 'pdd',
      title: '抽纸 3 层 120 抽 24 包',
      image_url: 'https://img.example.com/p/a1.jpg',
      user: { user_id: s.userId, phone_masked: null },
      paid_at: '2026-10-06T02:58:40.000Z',
      pay_amount_fen: 3990,
      est_commission_fen: 500,
      settle_commission_fen: null,
      platform_status: 'PAID',
      rebate_status: 'ESTIMATED',
      hold_reason: 'CS',
      flags: { locked: true, status_locked: false, rights_pending: false, hold: true },
    },
    {
      order_id: loose.order_id,
      sub_order_id: loose.sub_order_id,
      parent_order_id: null,
      platform: 'jd',
      title: null,
      image_url: null,
      user: null,
      paid_at: '2026-10-05T13:12:03.000Z',
      pay_amount_fen: 12900,
      est_commission_fen: 1032,
      settle_commission_fen: 990,
      platform_status: 'SETTLED',
      rebate_status: 'UNATTRIBUTED',
      hold_reason: null,
      flags: { locked: false, status_locked: false, rights_pending: true, hold: false },
    },
  ]);
});

it('[AC-B1-10i#22] platform、platform_status、rebate_status 按 AND 组合，total 为筛选集计数', async () => {
  const s = await setup(h);
  const hit = await order(s, {
    platform: 'pdd',
    platform_status: 'RECEIVED',
    rebate_status: 'WAITING',
  });
  const jd = await order(s, {
    platform: 'jd',
    platform_status: 'RECEIVED',
    rebate_status: 'WAITING',
  });
  const paid = await order(s, {
    platform: 'pdd',
    platform_status: 'PAID',
    rebate_status: 'WAITING',
  });
  const estimated = await order(s, {
    platform: 'pdd',
    platform_status: 'RECEIVED',
    rebate_status: 'ESTIMATED',
  });
  const all = { platform: 'pdd', platform_status: 'RECEIVED', rebate_status: 'WAITING' };
  expect(await page(await s.get(all))).toMatchObject({
    items: [expect.objectContaining({ order_id: hit.order_id })],
    total: 1,
  });
  const single: [Record<string, string>, string[]][] = [
    [{ platform: 'pdd' }, [hit.order_id, paid.order_id, estimated.order_id]],
    [{ platform_status: 'RECEIVED' }, [hit.order_id, jd.order_id, estimated.order_id]],
    [{ rebate_status: 'WAITING' }, [hit.order_id, jd.order_id, paid.order_id]],
  ];
  for (const [query, expected] of single) {
    const p = await page(await s.get(query));
    expect(ids(p).sort()).toEqual([...expected].sort());
    expect(p.total).toBe(3);
  }
  const misses: Record<string, string>[] = [
    { platform: 'taobao' },
    { platform_status: 'INVALID' },
    { ...all, platform: 'jd', platform_status: 'PAID' },
  ];
  for (const query of misses) {
    expect(await page(await s.get(query))).toMatchObject(EMPTY);
  }
});

it('[AC-B1-10i#23] flag 只列该标记为真的行；status_locked 由返利状态 VOID / CREDITED / CLAWED_BACK 派生', async () => {
  const s = await setup(h);
  const locked = await order(s, { locked: true });
  const rights = await order(s, { rights_pending: true, rebate_status: 'WAITING' });
  const held = await order(s, { hold: true, hold_reason: 'RISK' });
  const credited = await order(s, { rebate_status: 'CREDITED', platform_status: 'SETTLED' });
  const voided = await order(s, { rebate_status: 'VOID', platform_status: 'INVALID' });
  const clawed = await order(s, { rebate_status: 'CLAWED_BACK', platform_status: 'INVALID' });
  await order(s);
  await order(s, { rebate_status: 'WAITING', platform_status: 'RECEIVED' });
  const expected = {
    locked: [locked],
    rights_pending: [rights],
    hold: [held],
    status_locked: [credited, voided, clawed],
  };
  for (const [flag, rows] of Object.entries(expected)) {
    const p = await page(await s.get({ flag }));
    expect(ids(p).sort(), flag).toEqual(rows.map((o) => o.order_id).sort());
    expect(p.total).toBe(rows.length);
    for (const item of p.items) expect(item.flags[flag as keyof typeof item.flags]).toBe(true);
  }
});

it('[AC-B1-10i#24] user_id 只列归属该用户的订单，未归因的永不命中，应用内无此用户为空页', async () => {
  const s = await setup(h);
  const another = await seedUser(h.db, s.appId);
  const first = await order(s, { paid_at: '2026-10-06T01:00:00.000Z' });
  const second = await order(s, { paid_at: '2026-10-07T01:00:00.000Z' });
  const theirs = await order(s, { user_id: another });
  await order(s, UNATTRIBUTED);
  const p = await page(await s.get({ user_id: s.userId }));
  expect(ids(p)).toEqual([second.order_id, first.order_id]);
  expect(p.total).toBe(2);
  expect(ids(await page(await s.get({ user_id: another })))).toEqual([theirs.order_id]);
  expect(await page(await s.get({ user_id: randomUUID() }))).toMatchObject(EMPTY);
});

it('[AC-B1-10i#25] q 精确匹配子订单号或父订单号（父单号列出全部子单），去首尾与内部空格', async () => {
  const s = await setup(h);
  const parent = `P-${token()}`;
  const a = await order(s, { parent_order_id: parent, sub_order_id: `${parent}-1` });
  const b = await order(s, { parent_order_id: parent, sub_order_id: `${parent}-2` });
  const c = await order(s, { parent_order_id: `${parent}-X`, sub_order_id: `S-${token()}` });
  const cases: [string, string[]][] = [
    [parent, [a.order_id, b.order_id]],
    [`  ${parent.slice(0, 6)} ${parent.slice(6)}  `, [a.order_id, b.order_id]],
    [a.sub_order_id, [a.order_id]],
    [`${parent}-X`, [c.order_id]],
    [c.sub_order_id, [c.order_id]],
  ];
  for (const [q, expected] of cases) {
    const p = await page(await s.get({ q }));
    expect(ids(p).sort(), q).toEqual([...expected].sort());
    expect(p.total).toBe(expected.length);
  }
  for (const q of [parent.slice(0, 10), `${parent}-`, '%', '_', a.order_id, s.userId]) {
    expect(await page(await s.get({ q })), q).toMatchObject(EMPTY);
  }
});

it.each(['', '   ', 'x'.repeat(65)])(
  '[AC-B1-10i#26] q 规范化后长度不合法 %j 报 20001 q',
  async (q) => {
    const s = await setup(h);
    await order(s);
    await rejected(await s.get({ q }), 20001, { fields: ['q'] });
  },
);

it.each([1, 64])('[AC-B1-10i#27] q 长度边界 %s 在去空格之后判断', async (length) => {
  const s = await setup(h);
  const number = length === 1 ? 'Q' : `${token()}${token()}`;
  expect(number).toHaveLength(length);
  const o = await order(s, { platform: 'vip', sub_order_id: number });
  const spaced = `  ${number.split('').join(' ')}  `;
  expect(ids(await page(await s.get({ q: spaced })))).toEqual([o.order_id]);
});

it('[AC-B1-10i#28] paid_from 含、paid_to 不含，按带时区的时刻比较；无 paid_at 的行不命中任一边界', async () => {
  const s = await setup(h);
  const before = await order(s, { paid_at: '2026-10-05T15:59:59.000Z' });
  const start = await order(s, { paid_at: '2026-10-05T16:00:00.000Z' });
  const inside = await order(s, { paid_at: '2026-10-06T08:00:00.000Z' });
  const end = await order(s, { paid_at: '2026-10-06T16:00:00.000Z' });
  await order(s, { paid_at: null, platform_status: 'DEPOSIT_PAID' });
  const from = '2026-10-06T00:00:00+08:00';
  const to = '2026-10-07T00:00:00+08:00';
  const both = await page(await s.get({ paid_from: from, paid_to: to }));
  expect(ids(both)).toEqual([inside.order_id, start.order_id]);
  expect(both.total).toBe(2);
  expect(ids(await page(await s.get({ paid_from: from })))).toEqual([
    end.order_id,
    inside.order_id,
    start.order_id,
  ]);
  expect(ids(await page(await s.get({ paid_to: from })))).toEqual([before.order_id]);
  expect(await page(await s.get({ paid_from: from, paid_to: from }))).toMatchObject(EMPTY);
});

it('[AC-B1-10i#29] paid_from 晚于 paid_to 报 20001 [paid_from, paid_to]', async () => {
  const s = await setup(h);
  await order(s);
  await rejected(
    await s.get({ paid_from: '2026-10-07T00:00:00+08:00', paid_to: '2026-10-06T23:59:59+08:00' }),
    20001,
    { fields: ['paid_from', 'paid_to'] },
  );
});

it.each([
  ['platform', 'unknown'],
  ['platform_status', 'UNKNOWN'],
  ['rebate_status', 'UNKNOWN'],
  ['flag', 'unknown'],
  ['paid_from', 'yesterday'],
  ['paid_to', 'not-a-time'],
  ['page', '0'],
  ['page', '-1'],
  ['page', '1.5'],
  ['page_size', '0'],
  ['page_size', '201'],
  ['page_size', '1.5'],
])('[AC-B1-10i#30] 非法参数 %s=%s 报 20001 并指出该参数', async (key, value) => {
  const s = await setup(h);
  await order(s);
  await rejected(await s.get({ [key]: value }), 20001, { fields: [key] });
});
