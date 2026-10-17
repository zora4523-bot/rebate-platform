// F1-07b · GET /admin/v1/users/{user_id} (adminGetUser): user.list or user.lookup (either is
// enough, read only), unknown / other app / not a UUID → 20001 [user_id]; risk is the
// user_risk_state row (none → normal, nulls, row_version null); union_bindings one entry per
// platform with a binding row (that platform's latest row, ruling §9.2 #6), each with row_version.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  at,
  binding,
  detail,
  detailUrl,
  get,
  member,
  NO_RISK,
  noPlaintext,
  normalDetail,
  ok,
  rejected,
  riskRow,
  setup,
  user,
  type Detail,
} from './kit.ts';
import { DETAIL } from './schema.ts';

const h = useHarness();

const DETAIL_KEYS = [
  'created_at',
  'invite_code',
  'inviter_user_id',
  'level',
  'nickname',
  'phone_masked',
  'register_method',
  'registered_channel',
  'risk',
  'union_bindings',
  'user_id',
];

it.each([{ permissions: ['user.list'] }, { permissions: ['user.lookup'] }])(
  '[AC-F1-07b#24] 只持 $permissions 的非超管即可看详情 200，不要求二次验证',
  async ({ permissions }) => {
    const f = await setup(h);
    const target = await user(h, f.appId);
    const token = await member(h, f, permissions);
    for (const headers of [{}, { 'x-step-up-token': 'not-a-valid-step-up-token' }]) {
      const response = await get(f, detailUrl(target.id), { token, headers });
      const data = await ok<Detail>(response, DETAIL);
      expect(normalDetail(data)).toEqual(detail(target));
      noPlaintext(f, [target], response);
    }
  },
);

it.each([
  { permissions: [] },
  { permissions: ['pii.reveal_phone'] },
  { permissions: ['risk.freeze'] },
])(
  '[AC-F1-07b#25] user.list 与 user.lookup 都没有（$permissions）→ 10403 admin_permission_denied',
  async ({ permissions }) => {
    const f = await setup(h);
    const target = await user(h, f.appId);
    const token = await member(h, f, permissions);
    const response = await get(f, detailUrl(target.id), { token });
    await rejected(response, DETAIL, 10403, { reason: 'admin_permission_denied' });
    noPlaintext(f, [target], response);
  },
);

it('[AC-F1-07b#26] 未登录（无 admin_token）为 401 / 10001', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const response = await get(f, detailUrl(target.id), { token: null });
  await rejected(response, DETAIL, 10001);
  noPlaintext(f, [target], response);
});

it('[AC-F1-07b#27] 未知 user_id、别的 app 的用户（带不带 X-App-Id）、非 UUID 都是 20001 [user_id]', async () => {
  const f = await setup(h);
  // A real local user stays present: a read that forgets the user_id filter must fail.
  const local = await user(h, f.appId);
  const otherApp = `foreign-${randomUUID()}`;
  const foreign = await user(h, otherApp);
  const cases: [string, Record<string, string>][] = [
    [randomUUID(), {}],
    [foreign.id, {}],
    [foreign.id, { 'x-app-id': otherApp }],
    ['not-a-uuid', {}],
    ['12345', {}],
  ];
  for (const [id, headers] of cases) {
    const response = await get(f, detailUrl(id), { headers });
    await rejected(response, DETAIL, 20001, { fields: ['user_id'] });
    noPlaintext(f, [local, foreign], response);
  }
});

it('[AC-F1-07b#28] 没有 user_risk_state 行：risk 为 normal、其余为 null，row_version 为 null', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const data = await ok<Detail>(await get(f, detailUrl(target.id)), DETAIL);
  expect(data.risk).toEqual(NO_RISK);
  expect(data.risk.row_version).toBeNull();
  expect(normalDetail(data)).toEqual(detail(target));
});

it.each([
  { state: 'normal' as const, row_version: 0 },
  { state: 'frozen' as const, row_version: 0, reason_category: 'abnormal_trade' as const },
  { state: 'banned' as const, row_version: 3, reason_category: 'fraud_invite' as const },
  { state: 'appealing' as const, row_version: 7, reason_category: 'other' as const },
])(
  '[AC-F1-07b#29] 有风控行（$state，row_version=$row_version）时原样给出，row_version 恒为整数',
  async (row) => {
    const f = await setup(h);
    const target = await user(h, f.appId);
    const risk = await riskRow(h, target, {
      ...row,
      reason: row.state === 'normal' ? null : '同设备多账号集中下单，人工复核中',
      frozen_until: row.state === 'frozen' || row.state === 'appealing' ? at(60 * 24 * 60) : null,
      changed_by: 'ops-yi',
      changed_at: at(120),
    });
    const data = await ok<Detail>(await get(f, detailUrl(target.id)), DETAIL);
    expect(Number.isInteger(data.risk.row_version)).toBe(true);
    expect(data.risk.row_version).toBe(row.row_version);
    expect(normalDetail(data)).toEqual(detail(target, risk));
  },
);

it('[AC-F1-07b#30] union_bindings 每个有绑定行的平台一项，取该平台最新一行并带它的 row_version', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const other = await user(h, f.appId, { createdAt: at(1) });
  // taobao: an old released row, then the current active one.
  await binding(h, target, 'taobao', { status: 'released', createdAt: at(10), rowVersion: 3 });
  const taobao = await binding(h, target, 'taobao', {
    status: 'active',
    createdAt: at(200),
    rowVersion: 1,
  });
  // pdd: only released rows — the latest created_at wins.
  await binding(h, target, 'pdd', { status: 'released', createdAt: at(20), rowVersion: 0 });
  const pdd = await binding(h, target, 'pdd', {
    status: 'released',
    createdAt: at(80),
    rowVersion: 2,
    reason: '用户反馈绑错账号，重置授权',
  });
  // jd: two released rows of the same instant — the larger id wins (ruling §9.2 #6).
  const ids = [randomUUID(), randomUUID()].sort();
  await binding(h, target, 'jd', {
    id: ids[0]!,
    status: 'released',
    createdAt: at(30),
    rowVersion: 5,
  });
  const jd = await binding(h, target, 'jd', {
    id: ids[1]!,
    status: 'released',
    createdAt: at(30),
    rowVersion: 6,
  });
  // A blocked row (admin_disable) and a row still waiting for authorisation.
  const meituan = await binding(h, target, 'meituan', {
    status: 'blocked',
    createdAt: at(40),
    rowVersion: 4,
    reason: '错绑核实中，先停用返利',
  });
  const vip = await binding(h, target, 'vip', { status: 'pending_auth', createdAt: at(50) });
  // Another user's binding must not leak into this user's view.
  await binding(h, other, 'douyin', { status: 'active', createdAt: at(60) });
  const response = await get(f, detailUrl(target.id));
  const data = await ok<Detail>(response, DETAIL);
  expect(data.union_bindings.map((b) => b.platform).sort()).toEqual(
    ['jd', 'meituan', 'pdd', 'taobao', 'vip'].sort(),
  );
  // Compared as a set: sorted by platform on both sides (the contract fixes no order).
  expect(normalDetail(data)).toEqual(detail(target, NO_RISK, [taobao, pdd, jd, meituan, vip]));
  for (const b of data.union_bindings) expect(Number.isInteger(b.row_version)).toBe(true);
  noPlaintext(f, [target, other], response);
});

it('[AC-F1-07b#31] 详情只含契约字段：无订单、余额、流水、提现段，无明文、relation_id 或实名', async () => {
  const f = await setup(h);
  const parent = await user(h, f.appId, { createdAt: at(1) });
  const target = await user(h, f.appId, { createdAt: at(2), parentId: parent.id, level: 'L3' });
  const risk = await riskRow(h, target, {
    state: 'frozen',
    reason_category: 'account_security',
    reason: '账号异常登录',
    row_version: 0,
  });
  const taobao = await binding(h, target, 'taobao', { status: 'active', createdAt: at(3) });
  const response = await get(f, detailUrl(target.id));
  const data = await ok<Detail>(response, DETAIL);
  expect(Object.keys(data).sort()).toEqual(DETAIL_KEYS);
  expect(Object.keys(data.risk).sort()).toEqual([
    'changed_at',
    'changed_by',
    'frozen_until',
    'reason',
    'reason_category',
    'row_version',
    'state',
  ]);
  expect(data.union_bindings.map((b) => Object.keys(b).sort())).toEqual([
    [
      'blocked_reason',
      'bound_at',
      'cooldown_until',
      'platform',
      'reason',
      'released_at',
      'row_version',
      'status',
    ],
  ]);
  expect(normalDetail(data)).toEqual(detail(target, risk, [taobao]));
  expect(data.inviter_user_id).toBe(parent.id);
  noPlaintext(f, [target, parent], response);
});

it('[AC-F1-07b#32] 已注销用户的详情照常可见', async () => {
  const f = await setup(h);
  const gone = await user(h, f.appId, { status: 'deleted' });
  const data = await ok<Detail>(await get(f, detailUrl(gone.id)), DETAIL);
  expect(normalDetail(data)).toEqual(detail(gone));
});

it('[AC-F1-07b#33] 有当前行（pending_auth / active / invalid / blocked）时取当前行，即便 released 历史行同刻或更晚且 id 更大', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  // Per platform: one current row and a released history row whose created_at is the same or
  // later and whose id is larger, so "created_at, id descending" alone would pick the history.
  const cases = [
    { platform: 'taobao' as const, status: 'pending_auth' as const, later: false },
    { platform: 'jd' as const, status: 'active' as const, later: true },
    { platform: 'pdd' as const, status: 'invalid' as const, later: false },
    { platform: 'meituan' as const, status: 'blocked' as const, later: true },
  ];
  const expected = [];
  for (const [i, c] of cases.entries()) {
    const ids = [randomUUID(), randomUUID()].sort();
    const createdAt = at(100 + i * 10);
    const current = await binding(h, target, c.platform, {
      id: ids[0]!,
      status: c.status,
      createdAt,
      rowVersion: 2 + i,
    });
    await binding(h, target, c.platform, {
      id: ids[1]!,
      status: 'released',
      createdAt: c.later ? at(500 + i * 10) : createdAt,
      rowVersion: 9,
      reason: '历史绑定',
    });
    expected.push(current);
  }
  const response = await get(f, detailUrl(target.id));
  const data = await ok<Detail>(response, DETAIL);
  for (const c of cases) {
    const shown = data.union_bindings.filter((b) => b.platform === c.platform);
    expect(
      shown.map((b) => [b.status, b.row_version]),
      c.platform,
    ).toEqual([[c.status, 2 + cases.indexOf(c)]]);
  }
  expect(normalDetail(data)).toEqual(detail(target, NO_RISK, expected));
  noPlaintext(f, [target], response);
});
