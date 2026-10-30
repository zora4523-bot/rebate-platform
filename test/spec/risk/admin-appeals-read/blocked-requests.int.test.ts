// B1-03zd: GET /admin/v1/blocked-requests (adminListBlockedRequests; CT-24r, BR-ID-36 细则「被拦截请求
// 申诉」登记) — exactly one of phone / user_id / blocked_request_id; the phone normalised as BR-ID-05
// and matched through its blind index against the related phone and the account that holds the
// number now; only this app's 44001 records (risk_hits ref_type blocked_request), one item per
// request, newest first; masked 3 + 4 phones, never the hit value, an HMAC or the rule's
// conditions (BR-ID-33); a phone lookup that finds something writes one audit record.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DAY,
  HOUR,
  LOOKUP_FIELDS,
  PHONE_INVALID,
  accountAppeal,
  at,
  audits,
  blocked,
  blockedAppeal,
  blockedIds,
  found,
  hit,
  instants,
  mask,
  member,
  noSecrets,
  phoneNumber,
  rejected,
  setup,
  type Blocked,
  type BlockedItem,
  type Scenario,
} from './kit.ts';

const h = useHarness();
const EMPTY = { items: [], total: 0 };

/** U holds phone P now; requests related to P or made by U, plus noise that must not match. */
async function world(s: Scenario) {
  const u = await member(s);
  const v = await member(s);
  const p = u.phone!;
  const r1 = await blocked(s, { request_type: 'register', phone: p, blocked_at: at(-5 * HOUR) });
  const r2 = await blocked(s, {
    request_type: 'withdraw',
    user: u,
    phone: null,
    rules: [{ rule_id: 'WITHDRAW_VELOCITY', dimension: 'alipay' }],
    amount_fen: 8800,
    blocked_at: at(-4 * HOUR),
  });
  const r3 = await blocked(s, {
    request_type: 'phone_change',
    user: v,
    phone: p,
    blocked_at: at(-3 * HOUR),
  });
  const r4 = await blocked(s, {
    request_type: 'payout_account',
    user: u,
    rules: [{ rule_id: 'BLACKLIST_BANK_CARD', dimension: 'bank_card' }],
    blocked_at: at(-2 * HOUR),
  });
  const q = await blocked(s, { request_type: 'register', blocked_at: at(-HOUR) });
  const vWithdraw = await blocked(s, {
    request_type: 'withdraw',
    user: v,
    phone: null,
    rules: [{ rule_id: 'BLACKLIST_ALIPAY', dimension: 'alipay' }],
    blocked_at: at(-6 * HOUR),
  });
  // Not blocked requests: a manual-review hit on U's order is never listed.
  await hit(s, {
    user_id: u.id,
    rule_id: 'RIGHTS_ABUSE',
    ref_type: 'order',
    ref_id: randomUUID(),
    created_at: at(-30 * 60_000),
  });
  return { u, v, p, r1, r2, r3, r4, q, vWithdraw };
}

function item(
  b: Blocked,
  cause: BlockedItem['cause'],
  dimension: BlockedItem['blocklist_dimension'],
  processing: string | null = null,
): BlockedItem {
  return {
    blocked_request_id: b.id,
    request_type: b.request_type,
    phone_masked: b.masked,
    blocked_at: b.blocked_at.toISOString(),
    cause,
    blocklist_dimension: dimension,
    amount_fen: b.amount_fen,
    processing_appeal_id: processing,
  };
}

it.each<[string, Record<string, string>]>([
  ['都不给', {}],
  ['只给分页', { page: '1', page_size: '20' }],
  ['phone + user_id', { phone: '13800005678', user_id: randomUUID() }],
  ['user_id + blocked_request_id', { user_id: randomUUID(), blocked_request_id: randomUUID() }],
  ['phone + blocked_request_id', { phone: '13800005678', blocked_request_id: randomUUID() }],
  ['三个都给', { phone: '13800005678', user_id: randomUUID(), blocked_request_id: randomUUID() }],
])(
  '[AC-B1-03zd#40] 三选一：%s → 20001 [phone, user_id, blocked_request_id]',
  async (_label, query) => {
    const s = await setup(h);
    await rejected(await s.lookup(query), 20001, LOOKUP_FIELDS);
    expect(await audits(s)).toEqual([]);
  },
);

it.each(['12345678901', '1381234567', '138123456789', 'abc', '+1 202 555 0123', '0086 1381234567'])(
  '[AC-B1-03zd#41] 规范化后不是大陆手机号 %j → 20001 phone_invalid',
  async (phone) => {
    const s = await setup(h);
    await rejected(await s.lookup({ phone }), 20001, PHONE_INVALID);
    expect(await audits(s)).toEqual([]);
  },
);

it('[AC-B1-03zd#42] 按完整手机号：关联手机号为该号的被拦请求与该号当前所属账号的被拦请求，按拦截时间倒序；各种写法规范化后结果相同', async () => {
  const s = await setup(h);
  const { p, r1, r2, r3, r4 } = await world(s);
  const other = await setup(h);
  // Same number in another app (same keyring, same blind index): never listed here.
  await blocked(other, { request_type: 'register', phone: p, blocked_at: at(-HOUR) });

  const expected = [
    item(r4, 'blocklist', 'bank_card'),
    item(r3, 'blocklist', 'phone'),
    item(r2, 'rule', null),
    item(r1, 'blocklist', 'phone'),
  ];
  for (const phone of [
    p,
    ` ${p} `,
    `+86 ${p.slice(0, 3)} ${p.slice(3, 7)} ${p.slice(7)}`,
    `0086-${p}`,
    `86${p}`,
    `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}`,
  ]) {
    const result = await found(await s.lookup({ phone }));
    expect(result.items.map(instants), phone).toEqual(expected);
    expect(result).toMatchObject({ page: 1, page_size: 20, total: 4 });
  }
  expect(expected[2]!.phone_masked).toBeNull();
  expect(expected[0]!.phone_masked).toBe(mask(p));
});

it('[AC-B1-03zd#43] 按 UID：只列该用户的被拦请求（注册类没有用户），不列其他命中；应用内无此用户为空页', async () => {
  const s = await setup(h);
  const { u, v, r2, r3, r4, vWithdraw } = await world(s);
  const mine = await found(await s.lookup({ user_id: u.id }));
  expect(mine.items.map(instants)).toEqual([
    item(r4, 'blocklist', 'bank_card'),
    item(r2, 'rule', null),
  ]);
  expect(mine.total).toBe(2);
  expect(blockedIds(await found(await s.lookup({ user_id: v.id })))).toEqual([r3.id, vWithdraw.id]);
  expect(await found(await s.lookup({ user_id: randomUUID() }))).toMatchObject(EMPTY);
});

it('[AC-B1-03zd#44] 按拦截请求编号精确查找：无手机号的请求只能这样找到；未知或别的应用的编号为空页', async () => {
  const s = await setup(h);
  const { r2, r3 } = await world(s);
  const other = await setup(h);
  const foreign = await blocked(other, { request_type: 'register', blocked_at: at(-HOUR) });
  expect((await found(await s.lookup({ blocked_request_id: r2.id }))).items.map(instants)).toEqual([
    item(r2, 'rule', null),
  ]);
  expect(blockedIds(await found(await s.lookup({ blocked_request_id: r3.id })))).toEqual([r3.id]);
  for (const id of [randomUUID(), foreign.id]) {
    expect(await found(await s.lookup({ blocked_request_id: id })), id).toMatchObject(EMPTY);
  }
});

it('[AC-B1-03zd#45] 同一次请求的多条命中合并为一项', async () => {
  const s = await setup(h);
  const b = await blocked(s, {
    request_type: 'register',
    rules: [
      { rule_id: 'BLACKLIST_PHONE', dimension: 'phone' },
      { rule_id: 'BLACKLIST_DEVICE', dimension: 'device' },
    ],
    blocked_at: at(-HOUR),
  });
  for (const query of [{ phone: b.phone! }, { blocked_request_id: b.id }]) {
    const result = await found(await s.lookup(query));
    expect(blockedIds(result)).toEqual([b.id]);
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ cause: 'blocklist', phone_masked: b.masked });
    expect(['phone', 'device']).toContain(result.items[0]!.blocklist_dimension);
  }
});

it('[AC-B1-03zd#46] processing_appeal_id：本请求处理中的申诉；注册类另认同一关联手机号上处理中的申诉；已结案的不算', async () => {
  const s = await setup(h);
  const u = await member(s);
  const p = phoneNumber();
  const earlier = await blocked(s, {
    request_type: 'register',
    phone: p,
    blocked_at: at(-3 * DAY),
  });
  const later = await blocked(s, { request_type: 'register', phone: p, blocked_at: at(-DAY) });
  const onEarlier = await blockedAppeal(s, earlier, { created_at: at(-2 * DAY) });
  const withdraw = await blocked(s, {
    request_type: 'withdraw',
    user: u,
    blocked_at: at(-2 * HOUR),
  });
  const onWithdraw = await blockedAppeal(s, withdraw, { created_at: at(-HOUR) });
  const closedOne = await blocked(s, {
    request_type: 'payout_account',
    user: u,
    blocked_at: at(-3 * HOUR),
  });
  await blockedAppeal(s, closedOne, { status: 'upheld', created_at: at(-150 * 60_000) });
  // An account appeal of the same user is not an appeal on any blocked request.
  await accountAppeal(s, u, 'frozen');

  const byPhone = await found(await s.lookup({ phone: p }));
  expect(byPhone.items.map((i) => [i.blocked_request_id, i.processing_appeal_id])).toEqual([
    [later.id, onEarlier.id],
    [earlier.id, onEarlier.id],
  ]);
  const byUser = await found(await s.lookup({ user_id: u.id }));
  expect(byUser.items.map((i) => [i.blocked_request_id, i.processing_appeal_id])).toEqual([
    [withdraw.id, onWithdraw.id],
    [closedOne.id, null],
  ]);
});

it('[AC-B1-03zd#47] 分页：页码不重不漏，越过末页为空页；page_size 超过 200 或非法 → 20001', async () => {
  const s = await setup(h);
  const u = await member(s);
  const made: Blocked[] = [];
  for (let n = 1; n <= 5; n += 1) {
    made.push(await blocked(s, { request_type: 'withdraw', user: u, blocked_at: at(-n * HOUR) }));
  }
  const seen: string[] = [];
  for (let n = 1; n <= 3; n += 1) {
    const result = await found(await s.lookup({ user_id: u.id, page: String(n), page_size: '2' }));
    expect(result).toMatchObject({ page: n, page_size: 2, total: 5 });
    seen.push(...blockedIds(result));
  }
  expect(seen).toEqual(made.map((b) => b.id));
  expect(await found(await s.lookup({ user_id: u.id, page: '4', page_size: '2' }))).toMatchObject({
    ...EMPTY,
    total: 5,
  });
  expect((await found(await s.lookup({ user_id: u.id, page_size: '200' }))).total).toBe(5);
  for (const [key, value] of [
    ['page_size', '201'],
    ['page_size', '0'],
    ['page', '0'],
  ] as const) {
    await rejected(await s.lookup({ user_id: u.id, [key]: value }), 20001, { fields: [key] });
  }
});

it('[AC-B1-03zd#48] 按手机号查到结果写一条 blocked_request_lookup 审计（脱敏号码，无明文与 HMAC）；查无结果、按 UID 或编号查找都不写', async () => {
  const s = await setup(h);
  const { u, p, r2 } = await world(s);
  await found(await s.lookup({ user_id: u.id }));
  await found(await s.lookup({ blocked_request_id: r2.id }));
  await found(await s.lookup({ phone: phoneNumber() }));
  expect(await audits(s)).toEqual([]);

  await found(await s.lookup({ phone: `+86 ${p}` }));
  const rows = await audits(s);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: s.appId,
    admin_id: s.a.id,
    action: 'blocked_request_lookup',
  });
  expect(rows[0]!.at.toISOString()).toBe(s.f.clock.now().toISOString());
  const text = JSON.stringify(rows[0]);
  expect(text).toContain(mask(p));
  expect(text.includes(p)).toBe(false);
  expect(text.includes(u.hmac!)).toBe(false);
});

it('[AC-B1-03zd#49] 响应与日志不含完整手机号、命中值、HMAC 或规则条件', async () => {
  const s = await setup(h);
  const { u, v, p, r1, r2, r3, r4 } = await world(s);
  const responses = [
    await found(await s.lookup({ phone: p })),
    await found(await s.lookup({ user_id: u.id })),
    await found(await s.lookup({ blocked_request_id: r3.id })),
  ];
  noSecrets(
    [responses, s.f.lines],
    [p, v.phone, u.hmac, v.hmac, ...r1.secrets, ...r2.secrets, ...r3.secrets, ...r4.secrets],
  );
});
