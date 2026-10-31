// B1-03zd: GET /admin/v1/appeals (adminListAppeals; CT-24r) — rows, AND filters, overdue judged
// with the injected Clock, exact q, counts that ignore status and overdue, created_at descending
// pages, app isolation and 20001 for values outside the contract.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DAY,
  HOUR,
  accountAppeal,
  admin,
  at,
  blocked,
  blockedAppeal,
  ids,
  instants,
  listRow,
  member,
  noSecrets,
  order,
  orderAppeal,
  page,
  rejected,
  setup,
  type AppealRow,
  type Scenario,
} from './kit.ts';

const h = useHarness();
const ZERO = { processing: 0, overdue: 0, closed: 0, all: 0 };
const sorted = (rows: readonly AppealRow[]) => rows.map((r) => r.id).sort();

it('[AC-B1-03zd#20] 列表行照契约输出：申诉人 3+4 脱敏、对象编号、处理人显示名，按提交时间倒序，附四个计数', async () => {
  const s = await setup(h);
  const named = await admin(h, s.appId, { display_name: '客服小林' });
  const plain = await admin(h, s.appId);
  const u1 = await member(s, { state: 'appealing' });
  const u2 = await member(s, { phone: null });
  const u3 = await member(s);
  const account = await accountAppeal(s, u1, 'banned', {
    created_at: at(-2 * DAY),
    deadline_at: at(DAY),
    handler_id: named.id,
  });
  const o = await order(s, u2);
  const orderRow = await orderAppeal(s, u2, o, {
    status: 'upheld',
    created_at: at(-3 * DAY),
    handler_id: plain.id,
  });
  const withdraw = await blocked(s, {
    request_type: 'withdraw',
    user: u3,
    blocked_at: at(-5 * DAY),
  });
  const revoked = await blockedAppeal(s, withdraw, { status: 'revoked', created_at: at(-4 * DAY) });
  const register = await blocked(s, { request_type: 'register', blocked_at: at(-6 * DAY) });
  const registered = await blockedAppeal(s, register, {
    created_at: at(-5 * DAY),
    deadline_at: at(-2 * DAY),
  });

  const p = await page(await s.list());
  expect(p.items.map(instants)).toEqual([
    listRow(account, { user: u1, target_no: u1.id, handler_name: '客服小林' }),
    listRow(orderRow, { user: u2, target_no: o.sub_order_id, handler_name: plain.username }),
    listRow(revoked, { user: u3, target_no: withdraw.id, handler_name: s.a.username }),
    listRow(registered, { user: null, target_no: register.id, handler_name: null }),
  ]);
  expect(p).toMatchObject({
    page: 1,
    page_size: 20,
    total: 4,
    counts: { processing: 2, overdue: 1, closed: 2, all: 4 },
  });
  expect(p.items[1]!.user).toEqual({ user_id: u2.id, phone_masked: null });
  noSecrets([p, s.f.lines], [u1.phone, u3.phone, register.phone, u1.hmac, ...register.secrets]);
});

/** Six appeals covering every status, target type and deadline side of the Clock. */
async function matrix(s: Scenario) {
  const now = s.f.clock.now().getTime();
  const [ua, ub, uc] = [await member(s), await member(s), await member(s)];
  const a = await accountAppeal(s, ua, 'banned', {
    created_at: at(-6 * DAY),
    deadline_at: new Date(now - 1),
  });
  // Past for the wall clock, still ahead of the injected Clock: not overdue.
  const b = await accountAppeal(s, ub, 'frozen', {
    created_at: at(-5 * DAY),
    deadline_at: new Date(now + 1),
  });
  const c = await orderAppeal(s, uc, await order(s, uc), {
    created_at: at(-4 * DAY),
    deadline_at: at(-DAY),
  });
  const d = await orderAppeal(s, uc, await order(s, uc), {
    status: 'upheld',
    created_at: at(-7 * DAY),
    deadline_at: at(-4 * DAY),
  });
  const e = await blockedAppeal(
    s,
    await blocked(s, { request_type: 'register', blocked_at: at(-9 * DAY) }),
    { status: 'revoked', created_at: at(-8 * DAY), deadline_at: at(-5 * DAY) },
  );
  const f = await blockedAppeal(
    s,
    await blocked(s, { request_type: 'withdraw', user: ua, blocked_at: at(-4 * DAY) }),
    { created_at: at(-3 * HOUR), deadline_at: at(3 * DAY) },
  );
  return { a, b, c, d, e, f };
}

it('[AC-B1-03zd#21] status / overdue / target_type 按 AND 组合；overdue 只含处理中且按注入时钟已过 deadline_at；计数不受 status 与 overdue 影响', async () => {
  const s = await setup(h);
  const { a, b, c, d, e, f } = await matrix(s);
  const everything = { processing: 4, overdue: 2, closed: 2, all: 6 };
  const cases: [Record<string, string>, AppealRow[], typeof everything][] = [
    [{}, [a, b, c, d, e, f], everything],
    [{ status: 'processing' }, [a, b, c, f], everything],
    [{ status: 'upheld' }, [d], everything],
    [{ status: 'revoked' }, [e], everything],
    [{ overdue: 'true' }, [a, c], everything],
    [{ overdue: 'false' }, [a, b, c, d, e, f], everything],
    [{ target_type: 'account' }, [a, b], { processing: 2, overdue: 1, closed: 0, all: 2 }],
    [{ target_type: 'order' }, [c, d], { processing: 1, overdue: 1, closed: 1, all: 2 }],
    [{ target_type: 'blocked_request' }, [e, f], { processing: 1, overdue: 0, closed: 1, all: 2 }],
    [
      { status: 'processing', target_type: 'order', overdue: 'true' },
      [c],
      { processing: 1, overdue: 1, closed: 1, all: 2 },
    ],
    [{ status: 'upheld', overdue: 'true' }, [], everything],
    [
      { status: 'revoked', target_type: 'account' },
      [],
      { processing: 2, overdue: 1, closed: 0, all: 2 },
    ],
  ];
  for (const [query, rows, counts] of cases) {
    const p = await page(await s.list(query));
    const label = JSON.stringify(query);
    expect([...ids(p)].sort(), label).toEqual(sorted(rows));
    expect(p.total, label).toBe(rows.length);
    expect(p.counts, label).toEqual(counts);
  }
});

it('[AC-B1-03zd#22] 时钟前移越过 deadline_at 后同一申诉变为超时', async () => {
  const s = await setup(h);
  const user = await member(s, { state: 'appealing' });
  // Ten minutes ahead: within the admin session's idle timeout.
  const row = await accountAppeal(s, user, 'frozen', {
    created_at: at(-HOUR),
    deadline_at: at(10 * 60_000),
  });
  expect(await page(await s.list({ overdue: 'true' }))).toMatchObject({ items: [], total: 0 });
  s.f.clock.advanceMs(10 * 60_000 + 1);
  const p = await page(await s.list({ overdue: 'true' }));
  expect(ids(p)).toEqual([row.id]);
  expect(p.counts).toEqual({ processing: 1, overdue: 1, closed: 0, all: 1 });
});

it('[AC-B1-03zd#23] q 去首尾空白后精确匹配 appeal_id 或申诉人 UID，计数随 q 收窄', async () => {
  const s = await setup(h);
  const other = await setup(h);
  const u = await member(s, { state: 'appealing' });
  const v = await member(s, { state: 'appealing' });
  const o = await order(s, u);
  const x = await accountAppeal(s, u, 'banned', { created_at: at(-DAY) });
  const y = await orderAppeal(s, u, o, { status: 'upheld', created_at: at(-2 * DAY) });
  const withdraw = await blocked(s, {
    request_type: 'withdraw',
    user: u,
    blocked_at: at(-4 * DAY),
  });
  const w = await blockedAppeal(s, withdraw, { created_at: at(-3 * DAY), deadline_at: at(DAY) });
  const z = await accountAppeal(s, v, 'frozen', { created_at: at(-5 * DAY) });
  const register = await blocked(s, { request_type: 'register', blocked_at: at(-7 * DAY) });
  await blockedAppeal(s, register, { created_at: at(-6 * DAY) });
  const foreignUser = await member(other, { state: 'appealing' });
  const foreign = await accountAppeal(other, foreignUser, 'banned');

  const cases: [string, AppealRow[]][] = [
    [x.id, [x]],
    [`  ${y.id}\t`, [y]],
    [z.id, [z]],
    [u.id, [x, y, w]],
    [` ${v.id} `, [z]],
  ];
  for (const [q, rows] of cases) {
    const p = await page(await s.list({ q }));
    expect([...ids(p)].sort(), q).toEqual(sorted(rows));
    expect(p.total, q).toBe(rows.length);
  }
  expect((await page(await s.list({ q: u.id }))).counts).toEqual({
    processing: 2,
    overdue: 0,
    closed: 1,
    all: 3,
  });
  const narrowed = await page(await s.list({ q: u.id, status: 'processing' }));
  expect([...ids(narrowed)].sort()).toEqual(sorted([x, w]));
  expect(narrowed.counts).toEqual({ processing: 2, overdue: 0, closed: 1, all: 3 });

  // Exact only: no prefix, no target ids, no order numbers, nothing of another app.
  for (const q of [
    x.id.slice(0, 8),
    `${x.id}0`,
    o.order_id,
    o.sub_order_id,
    withdraw.id,
    register.id,
    foreign.id,
    foreignUser.id,
    'not-an-appeal-number',
    'x',
  ]) {
    const p = await page(await s.list({ q }));
    expect(p, q).toMatchObject({ items: [], total: 0 });
    expect(p.counts, q).toEqual(ZERO);
  }
});

it.each(['', '   ', 'x'.repeat(65), ` ${'x'.repeat(65)} `])(
  '[AC-B1-03zd#24] q 去空白后长度不在 1–64（%j）→ 20001 [q]',
  async (q) => {
    const s = await setup(h);
    await accountAppeal(s, await member(s, { state: 'appealing' }), 'banned');
    await rejected(await s.list({ q }), 20001, { fields: ['q'] });
  },
);

it.each([1, 64])('[AC-B1-03zd#25] q 长度边界 %s 合法，无匹配为空页', async (length) => {
  const s = await setup(h);
  await accountAppeal(s, await member(s, { state: 'appealing' }), 'banned');
  const p = await page(await s.list({ q: `  ${'q'.repeat(length)}  ` }));
  expect(p).toMatchObject({ items: [], total: 0, counts: ZERO });
});

it.each([
  ['status', 'pending'],
  ['status', 'PROCESSING'],
  ['target_type', 'register_request'],
  ['target_type', 'user'],
  ['overdue', 'yes'],
  ['page', '0'],
  ['page', '-1'],
  ['page', '1.5'],
  ['page_size', '0'],
  ['page_size', '201'],
  ['page_size', 'many'],
])('[AC-B1-03zd#26] 非法参数 %s=%s → 20001 并指出该参数', async (key, value) => {
  const s = await setup(h);
  await accountAppeal(s, await member(s, { state: 'appealing' }), 'banned');
  await rejected(await s.list({ [key]: value }), 20001, { fields: [key] });
});

it('[AC-B1-03zd#27] created_at 倒序、同刻由服务端定序；页码分页不重不漏，越过末页为空页，total 与计数每页一致', async () => {
  const s = await setup(h);
  const rows: AppealRow[] = [];
  for (const offset of [-1, -2, -2, -3, -4]) {
    const user = await member(s, { state: 'appealing' });
    rows.push(await accountAppeal(s, user, 'banned', { created_at: at(offset * HOUR) }));
  }
  const [newest, tieA, tieB, older, oldest] = rows as [
    AppealRow,
    AppealRow,
    AppealRow,
    AppealRow,
    AppealRow,
  ];
  const all = await page(await s.list({ page_size: '200' }));
  expect(all).toMatchObject({ page: 1, page_size: 200, total: 5 });
  expect(ids(all)[0]).toBe(newest.id);
  expect([...ids(all).slice(1, 3)].sort()).toEqual(sorted([tieA, tieB]));
  expect(ids(all).slice(3)).toEqual([older.id, oldest.id]);
  const seen: string[] = [];
  for (let n = 1; n <= 3; n += 1) {
    const p = await page(await s.list({ page: String(n), page_size: '2' }));
    expect(p).toMatchObject({ page: n, page_size: 2, total: 5 });
    expect(p.counts).toEqual({ processing: 5, overdue: 0, closed: 0, all: 5 });
    expect(ids(p)).toEqual(ids(all).slice((n - 1) * 2, n * 2));
    seen.push(...ids(p));
  }
  expect(seen).toEqual(ids(all));
  expect(await page(await s.list({ page: '4', page_size: '2' }))).toMatchObject({
    items: [],
    page: 4,
    page_size: 2,
    total: 5,
  });
  expect((await page(await s.list({ page: '100000' }))).items).toEqual([]);
});

it('[AC-B1-03zd#28] 没有申诉或筛选无命中为空页（items=[]、total=0），不是错误', async () => {
  const s = await setup(h);
  expect(await page(await s.list())).toEqual({
    items: [],
    page: 1,
    page_size: 20,
    total: 0,
    counts: ZERO,
  });
  await accountAppeal(s, await member(s, { state: 'appealing' }), 'banned');
  expect(await page(await s.list({ target_type: 'order' }))).toMatchObject({
    items: [],
    total: 0,
    counts: ZERO,
  });
  expect(await page(await s.list({ q: randomUUID() }))).toMatchObject({ items: [], total: 0 });
});

it('[AC-B1-03zd#29] 只列本控制台应用的申诉，计数也只算本应用；身份头不能换应用', async () => {
  const s = await setup(h);
  const other = await setup(h);
  const mine = await accountAppeal(s, await member(s, { state: 'appealing' }), 'banned');
  const theirs = await member(other, { state: 'appealing' });
  await accountAppeal(other, theirs, 'frozen');
  await orderAppeal(other, theirs, await order(other, theirs), { status: 'upheld' });
  const p = await page(await s.list({}, { 'x-app-id': other.appId }));
  expect(ids(p)).toEqual([mine.id]);
  expect(p.counts).toEqual({ processing: 1, overdue: 0, closed: 0, all: 1 });
});
