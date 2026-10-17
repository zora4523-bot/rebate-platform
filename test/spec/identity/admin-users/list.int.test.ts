// F1-07b · GET /admin/v1/users (adminListUsers): user.list only, read only (no step-up), users of
// the console's app newest registration first (same instant: id descending), page / page_size
// ≤ 200, optional risk_state (no user_risk_state row counts as normal), non-sensitive rows only.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  at,
  get,
  listItem,
  member,
  newestFirst,
  noPlaintext,
  normalItem,
  ok,
  rejected,
  riskRow,
  setup,
  url,
  user,
  type Page,
} from './kit.ts';
import { LIST } from './schema.ts';

const h = useHarness();

it('[AC-F1-07b#3] 持 user.list 的非超管 200；不带二次验证令牌、带无效令牌都照常返回（只读）', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const token = await member(h, f, ['user.list']);
  for (const headers of [{}, { 'x-step-up-token': 'not-a-valid-step-up-token' }]) {
    const response = await get(f, LIST, { token, headers });
    const page = await ok<Page>(response, LIST);
    expect(page.items.map(normalItem)).toEqual([listItem(target)]);
    expect(page).toMatchObject({ page: 1, page_size: 20, total: 1 });
    noPlaintext(f, [target], response);
  }
});

it.each([
  { permissions: ['user.lookup'] },
  { permissions: [] },
  { permissions: ['pii.reveal_phone'] },
])(
  '[AC-F1-07b#4] 只持 $permissions（没有 user.list）不能浏览列表：10403 admin_permission_denied',
  async ({ permissions }) => {
    const f = await setup(h);
    const target = await user(h, f.appId);
    const token = await member(h, f, permissions);
    const response = await get(f, LIST, { token });
    await rejected(response, LIST, 10403, { reason: 'admin_permission_denied' });
    noPlaintext(f, [target], response);
  },
);

it('[AC-F1-07b#5] 未登录（无 admin_token）为 401 / 10001', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const response = await get(f, LIST, { token: null });
  await rejected(response, LIST, 10001);
  noPlaintext(f, [target], response);
});

it('[AC-F1-07b#6] 注册时间倒序，同一时刻按 id 倒序；默认 page=1、page_size=20，total 为总数', async () => {
  const f = await setup(h);
  const same = at(50);
  const users = [
    await user(h, f.appId, { createdAt: at(10) }),
    await user(h, f.appId, { createdAt: at(90) }),
    await user(h, f.appId, { createdAt: same }),
    await user(h, f.appId, { createdAt: same }),
    await user(h, f.appId, { createdAt: same }),
    await user(h, f.appId, { createdAt: at(70), phone: null }),
    await user(h, f.appId, { createdAt: at(30), level: 'L3' }),
  ];
  const page = await ok<Page>(await get(f, LIST), LIST);
  expect(page.items.map(normalItem)).toEqual(newestFirst(users).map((u) => listItem(u)));
  expect(page).toMatchObject({ page: 1, page_size: 20, total: 7 });
});

it('[AC-F1-07b#7] 页码分页：各页衔接不重不漏，total 不随页变化；page_size=200 为合法上限', async () => {
  const f = await setup(h);
  const same = at(40);
  const users = [];
  for (let i = 0; i < 7; i += 1) {
    users.push(await user(h, f.appId, { createdAt: i % 3 === 0 ? same : at(i * 7) }));
  }
  const expected = newestFirst(users).map((u) => listItem(u));
  const pages = [];
  for (const page of [1, 2, 3]) {
    const data = await ok<Page>(await get(f, url(LIST, { page, page_size: 3 })), LIST);
    expect(data).toMatchObject({ page, page_size: 3, total: 7 });
    pages.push(data.items.map(normalItem));
  }
  expect(pages).toEqual([expected.slice(0, 3), expected.slice(3, 6), expected.slice(6)]);
  const wide = await ok<Page>(await get(f, url(LIST, { page_size: 200 })), LIST);
  expect(wide).toMatchObject({ page: 1, page_size: 200, total: 7 });
  expect(wide.items.map(normalItem)).toEqual(expected);
});

it.each([
  { query: { page_size: 201 }, fields: ['page_size'] },
  { query: { page_size: 0 }, fields: ['page_size'] },
  { query: { page: 0 }, fields: ['page'] },
])('[AC-F1-07b#8] 分页参数越界 $query → 20001 data.fields=$fields', async ({ query, fields }) => {
  const f = await setup(h);
  await user(h, f.appId);
  const response = await get(f, url(LIST, query));
  await rejected(response, LIST, 20001);
  // data.fields is compared exactly: one offending parameter, as in AdminPageSizeInvalid.
  expect(response.json<{ data: { fields: string[] } }>().data.fields).toEqual(fields);
});

it('[AC-F1-07b#9] risk_state 过滤：没有 user_risk_state 行算 normal，有行按行的 state', async () => {
  const f = await setup(h);
  const none = await user(h, f.appId, { createdAt: at(1) });
  const normal = await user(h, f.appId, { createdAt: at(2) });
  const frozen = await user(h, f.appId, { createdAt: at(3) });
  const banned = await user(h, f.appId, { createdAt: at(4) });
  const appealing = await user(h, f.appId, { createdAt: at(5) });
  await riskRow(h, normal, { state: 'normal', row_version: 2 });
  await riskRow(h, frozen, { state: 'frozen', reason_category: 'abnormal_trade' });
  await riskRow(h, banned, { state: 'banned', reason_category: 'fraud_invite' });
  await riskRow(h, appealing, { state: 'appealing', reason_category: 'other' });
  const all = await ok<Page>(await get(f, LIST), LIST);
  expect(all.items.map(normalItem)).toEqual([
    listItem(appealing, 'appealing'),
    listItem(banned, 'banned'),
    listItem(frozen, 'frozen'),
    listItem(normal, 'normal'),
    listItem(none, 'normal'),
  ]);
  expect(all.total).toBe(5);
  const cases = [
    { state: 'normal', users: [listItem(normal, 'normal'), listItem(none, 'normal')] },
    { state: 'frozen', users: [listItem(frozen, 'frozen')] },
    { state: 'banned', users: [listItem(banned, 'banned')] },
    { state: 'appealing', users: [listItem(appealing, 'appealing')] },
  ];
  for (const c of cases) {
    const page = await ok<Page>(await get(f, url(LIST, { risk_state: c.state })), LIST);
    expect(page.items.map(normalItem), c.state).toEqual(c.users);
    expect(page.total, c.state).toBe(c.users.length);
  }
});

it('[AC-F1-07b#10] 只列本 app 用户：别的 app 的用户既不出现也不计入 total，X-App-Id 改不了范围', async () => {
  const f = await setup(h);
  const otherApp = `foreign-${randomUUID()}`;
  const foreign = await user(h, otherApp, { createdAt: at(99) });
  await riskRow(h, foreign, { state: 'frozen', reason_category: 'other' });
  const local = await user(h, f.appId, { createdAt: at(1) });
  for (const headers of [{}, { 'x-app-id': otherApp }]) {
    const response = await get(f, LIST, { headers });
    const page = await ok<Page>(response, LIST);
    expect(page.items.map(normalItem)).toEqual([listItem(local)]);
    expect(page.total).toBe(1);
    const frozen = await ok<Page>(
      await get(f, url(LIST, { risk_state: 'frozen' }), { headers }),
      LIST,
    );
    expect(frozen).toMatchObject({ items: [], total: 0 });
    noPlaintext(f, [foreign, local], response);
  }
});

it('[AC-F1-07b#11] 行只含契约六个字段：手机号首三末四、未绑为 null，无明文、密文、实名或风控原因', async () => {
  const f = await setup(h);
  const bound = await user(h, f.appId, { createdAt: at(2) });
  const unbound = await user(h, f.appId, { createdAt: at(1), phone: null });
  await riskRow(h, bound, {
    state: 'frozen',
    reason_category: 'abnormal_trade',
    reason: '内部复核原因不得出现在列表',
  });
  const response = await get(f, LIST);
  const page = await ok<Page>(response, LIST);
  expect(page.items.map((item) => Object.keys(item).sort())).toEqual([
    ['created_at', 'level', 'nickname', 'phone_masked', 'risk_state', 'user_id'],
    ['created_at', 'level', 'nickname', 'phone_masked', 'risk_state', 'user_id'],
  ]);
  expect(page.items[0]!.phone_masked).toBe(
    `${bound.phone!.slice(0, 3)}****${bound.phone!.slice(-4)}`,
  );
  expect(page.items[1]!.phone_masked).toBeNull();
  expect(page.items.map(normalItem)).toEqual([listItem(bound, 'frozen'), listItem(unbound)]);
  expect(JSON.stringify(response.json())).not.toContain('内部复核原因');
  noPlaintext(f, [bound, unbound], response);
});

it('[AC-F1-07b#12] 已注销用户照常出现在列表里（运营要能查到注销账号）', async () => {
  const f = await setup(h);
  const live = await user(h, f.appId, { createdAt: at(1) });
  const gone = await user(h, f.appId, { createdAt: at(2), status: 'deleted' });
  const page = await ok<Page>(await get(f, LIST), LIST);
  expect(page.items.map(normalItem)).toEqual([listItem(gone), listItem(live)]);
  expect(page.total).toBe(2);
});
